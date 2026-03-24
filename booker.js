const puppeteer = require("puppeteer");

const BASE_URL = "https://scheduling.tools.lib.utah.edu";
const SCHEDULE_URL = (date) =>
  `${BASE_URL}/Web/schedule.php?sd=${date}`;

// Known study rooms at Marriott Library - user can pick from these
const KNOWN_ROOMS = [
  "2130S Study room",
  "2110S Study room",
  "2120S Study room",
  "2140S Study room",
  "2150S Study room",
  "2160S Study room",
  "2170S Study room",
  "2180S Study room",
];

async function bookRoom(opts, onProgress) {
  const {
    username,
    password,
    cookie,
    date = "2026-3-29",
    startTime = "11:00",
    endTime = "14:00",
    room = "2130S Study room",
  } = opts;

  const log = (msg) => {
    console.log(`[booker] ${msg}`);
    if (onProgress) onProgress(msg);
  };

  const isServer = process.env.DEPLOYED === "true";
  const launchOpts = {
    headless: isServer ? "new" : false,
    defaultViewport: isServer ? { width: 1280, height: 900 } : null,
    args: isServer
      ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
      : ["--start-maximized"],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    launchOpts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const browser = await puppeteer.launch(launchOpts);

  const page = await browser.newPage();
  page.setDefaultTimeout(120000); // 2 min timeout for Duo wait

  try {
    // If a session cookie is provided, set it before navigating
    if (cookie) {
      log("Setting session cookie...");
      const cookies = parseCookieString(cookie, BASE_URL);
      await page.setCookie(...cookies);
      log("Cookie set. Navigating to schedule...");
    }

    log(`Navigating to schedule for ${date}...`);
    await page.goto(SCHEDULE_URL(date), { waitUntil: "networkidle2" });

    // Check if we hit a login page (CAS auth)
    const currentUrl = page.url();
    if (
      currentUrl.includes("cas.utah.edu") ||
      currentUrl.includes("login") ||
      currentUrl.includes("go.utah.edu")
    ) {
      if (!username || !password) {
        throw new Error(
          "Login required but no username/password provided. Either provide credentials or a valid session cookie."
        );
      }

      log("Login page detected. Entering credentials...");
      await handleCASLogin(page, username, password, log);
    }

    // After auth, we may land on dashboard instead of schedule - navigate there
    if (!page.url().includes("schedule.php")) {
      log(`Landed on ${page.url()} after auth. Navigating to schedule...`);
      await page.goto(SCHEDULE_URL(date), { waitUntil: "networkidle2" });
    }

    log(`On schedule page. URL: ${page.url()}`);
    log("Waiting for schedule page to load...");
    try {
      await page.waitForSelector("#reservations, .schedule, table, .reservations", {
        timeout: 30000,
      });
    } catch {
      // Log page content to help debug what selectors are actually on the page
      const pageTitle = await page.title();
      const bodySnippet = await page.evaluate(() =>
        document.body ? document.body.innerHTML.substring(0, 500) : "no body"
      );
      log(`Page title: ${pageTitle}`);
      log(`Page HTML snippet: ${bodySnippet}`);
      throw new Error(
        "Schedule page did not load expected selectors. See logs above for page content."
      );
    }

    log("Schedule loaded. Looking for available rooms...");

    // Log page structure to help debug scraping
    const pageDebug = await page.evaluate(() => {
      const ids = Array.from(document.querySelectorAll("[id]"))
        .slice(0, 20)
        .map((el) => `${el.tagName}#${el.id}`);
      const classes = Array.from(document.querySelectorAll("[class]"))
        .slice(0, 30)
        .map((el) => `${el.tagName}.${el.className.split(" ").join(".")}`);
      const links = Array.from(document.querySelectorAll("a[href*='reservation'], a[href*='schedule']"))
        .slice(0, 10)
        .map((a) => ({ text: a.textContent?.trim(), href: a.href }));
      const tables = document.querySelectorAll("table").length;
      const tds = Array.from(document.querySelectorAll("td[data-resourceid], td[class*='reserv'], td[class*='slot']"))
        .slice(0, 5)
        .map((td) => ({ class: td.className, attrs: Array.from(td.attributes).map((a) => `${a.name}=${a.value}`) }));
      return { ids, classes, links, tables, tds, bodyLength: document.body?.innerHTML.length };
    });
    log(`Page structure: ${JSON.stringify(pageDebug)}`);

    // Scrape available rooms and time slots
    const availableRooms = await scrapeAvailableRooms(page, date, startTime, endTime);

    if (availableRooms.length === 0) {
      log("No rooms available for the selected time slot.");
      await browser.close();
      return {
        success: false,
        message: "No rooms available for the selected time slot.",
        availableRooms: [],
      };
    }

    // Check if preferred room is available
    const preferredRoom = availableRooms.find((r) =>
      r.name.toLowerCase().includes(room.toLowerCase())
    );

    if (preferredRoom) {
      log(`Preferred room "${room}" is available! Booking...`);
      await clickAndBook(page, preferredRoom, startTime, endTime, log);
      await browser.close();
      return {
        success: true,
        message: `Successfully booked ${room} from ${startTime} to ${endTime} on ${date}`,
        bookedRoom: room,
      };
    }

    // Preferred room not available, return alternatives
    log(
      `Preferred room "${room}" is not available. Found ${availableRooms.length} other room(s).`
    );
    await browser.close();
    return {
      success: false,
      message: `Preferred room "${room}" is not available.`,
      availableRooms: availableRooms.map((r) => r.name),
    };
  } catch (err) {
    log(`Error: ${err.message}`);
    // Don't close browser on error so user can debug
    throw err;
  }
}

async function handleCASLogin(page, username, password, log) {
  // University of Utah CAS login
  try {
    // Wait for username field
    await page.waitForSelector(
      'input[name="username"], input[id="username"], input[type="text"]',
      { timeout: 15000 }
    );

    const usernameSelector = (await page.$('input[name="username"]'))
      ? 'input[name="username"]'
      : (await page.$('input[id="username"]'))
        ? 'input[id="username"]'
        : 'input[type="text"]';

    await page.type(usernameSelector, username, { delay: 50 });
    log("Username entered.");

    // Some CAS systems have a "Next" button before password
    const nextBtn = await page.$(
      'button[name="next"], input[type="submit"][value="Next"]'
    );
    if (nextBtn) {
      await nextBtn.click();
      await page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {});
    }

    // Password field
    await page.waitForSelector(
      'input[name="password"], input[id="password"], input[type="password"]',
      { timeout: 10000 }
    );

    const passwordSelector = (await page.$('input[name="password"]'))
      ? 'input[name="password"]'
      : (await page.$('input[id="password"]'))
        ? 'input[id="password"]'
        : 'input[type="password"]';

    await page.type(passwordSelector, password, { delay: 50 });
    log("Password entered.");

    // Click login/submit button and wait for navigation to Duo
    const submitBtn = await page.$(
      'button[type="submit"], input[type="submit"], button[name="submit"], .btn-submit, #submit'
    );

    log("Submitting credentials...");
    // Use Promise.all to click and wait for navigation simultaneously
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
      submitBtn ? submitBtn.click() : page.keyboard.press("Enter"),
    ]);

    log("Credentials submitted. Waiting for Duo authentication...");
    log(">>> Please approve the Duo push on your phone <<<");

    let currentUrl = page.url();
    log(`After credentials, current URL: ${currentUrl}`);

    // Check for Duo iframe (legacy Duo)
    const duoFrame = await page.$(
      'iframe[id="duo_iframe"], #duo-frame, iframe[src*="duosecurity"]'
    );
    if (duoFrame) {
      log("Duo iframe detected. Trying to auto-click push...");
      try {
        const frame = await duoFrame.contentFrame();
        if (frame) {
          const pushBtn = await frame.$(
            'button.auth-button.positive, button[type="submit"]'
          );
          if (pushBtn) {
            await pushBtn.click();
            log("Auto-clicked 'Send Me a Push'. Approve on your phone.");
          }
        }
      } catch {
        log("Could not auto-click Duo push. Please manually approve.");
      }
    }

    // Check for Duo Universal Prompt (redirect-based, not iframe)
    currentUrl = page.url();
    if (currentUrl.includes("duosecurity.com") || currentUrl.includes("duo.com")) {
      log("Duo Universal Prompt detected. Waiting for page to fully load...");

      // Wait for Duo page to be fully loaded and interactive
      await page.waitForFunction(
        () => document.readyState === "complete",
        { timeout: 15000 }
      ).catch(() => {});
      // Extra wait for Duo's JS framework to render
      await new Promise((r) => setTimeout(r, 3000));

      // Log all buttons on the page for debugging
      const buttons = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, input[type='submit'], [role='button']"));
        return btns.map((b) => ({
          text: b.textContent?.trim(),
          type: b.type,
          className: b.className,
          id: b.id,
          ariaLabel: b.getAttribute("aria-label"),
        }));
      });
      log(`Duo page buttons: ${JSON.stringify(buttons)}`);

      // Try clicking "Send Me a Push" or similar button
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, input[type='submit'], [role='button']"));
        for (const btn of btns) {
          const text = (btn.textContent || "").toLowerCase();
          if (
            text.includes("send me a push") ||
            text.includes("send push") ||
            text.includes("duo push") ||
            text.includes("push")
          ) {
            btn.click();
            return btn.textContent.trim();
          }
        }
        // If no push button, try the first primary/submit button
        const primary = document.querySelector(
          "button.btn-primary, button[type='submit'], .primary-btn"
        );
        if (primary) {
          primary.click();
          return primary.textContent?.trim() || "primary button";
        }
        return null;
      });

      if (clicked) {
        log(`Auto-clicked Duo button: "${clicked}". Approve on your phone.`);
      } else {
        log("Could not find a push button on Duo page. Please approve manually.");
      }
    }

    // Poll every 5 seconds for Duo approval (up to 2 minutes)
    log("Waiting for Duo approval (checking every 5s, up to 2 minutes)...");
    const maxAttempts = 24; // 24 × 5s = 120s
    let approved = false;
    for (let i = 1; i <= maxAttempts; i++) {
      currentUrl = page.url();
      const onSchedulingSite = currentUrl.includes(BASE_URL);

      if (onSchedulingSite) {
        approved = true;
        break;
      }

      // If still on Duo page, check for post-approval state and try to proceed
      if (currentUrl.includes("duosecurity.com") || currentUrl.includes("duo.com")) {
        const duoState = await page.evaluate(() => {
          const body = document.body ? document.body.innerText : "";
          const html = document.body ? document.body.innerHTML.substring(0, 1000) : "";
          // Look for success indicators
          const hasSuccess =
            body.includes("Success") ||
            body.includes("Authenticated") ||
            body.includes("Logging you in") ||
            body.includes("approved") ||
            document.querySelector(".success-status, .access-granted, [data-testid='success']") !== null;
          // Look for "Trust browser" prompt that appears after approval
          const hasTrustPrompt =
            body.includes("trust this browser") ||
            body.includes("Trust browser") ||
            body.includes("remember me") ||
            body.includes("Is this your device");
          // Look for any clickable button that might continue the flow
          const btns = Array.from(document.querySelectorAll("button, input[type='submit'], [role='button'], a.btn"));
          const btnTexts = btns.map((b) => (b.textContent || "").trim()).filter(Boolean);
          return { hasSuccess, hasTrustPrompt, btnTexts, bodySnippet: body.substring(0, 300), htmlSnippet: html };
        });

        if (duoState.hasSuccess || duoState.hasTrustPrompt) {
          log(`Duo approved! State: success=${duoState.hasSuccess}, trustPrompt=${duoState.hasTrustPrompt}`);
          log(`Buttons on page: ${JSON.stringify(duoState.btnTexts)}`);

          // Try to click through trust/continue prompts
          await page.evaluate(() => {
            const btns = Array.from(document.querySelectorAll("button, input[type='submit'], [role='button'], a.btn"));
            for (const btn of btns) {
              const text = (btn.textContent || "").toLowerCase();
              if (
                text.includes("trust") ||
                text.includes("yes") ||
                text.includes("continue") ||
                text.includes("done") ||
                text.includes("log in") ||
                text.includes("proceed")
              ) {
                btn.click();
                return;
              }
            }
            // Click any primary button as fallback
            const primary = document.querySelector("button.btn-primary, button[type='submit']");
            if (primary) primary.click();
          });

          // Wait for redirect after clicking
          await new Promise((r) => setTimeout(r, 5000));
          if (page.url().includes(BASE_URL)) {
            approved = true;
            break;
          }
          log(`After clicking trust/continue, URL: ${page.url()}`);
        }

        if (i % 4 === 0) {
          // Every 20s, log the Duo page state for debugging
          log(`Duo page body: ${duoState.bodySnippet}`);
        }
      }

      // If we've left Duo/CAS, we might be mid-redirect
      const onDuoOrCas =
        currentUrl.includes("duosecurity.com") ||
        currentUrl.includes("duo.com") ||
        currentUrl.includes("cas.utah.edu");
      if (!onDuoOrCas) {
        log(`No longer on Duo/CAS. URL: ${currentUrl}`);
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 }).catch(() => {});
        if (page.url().includes(BASE_URL)) {
          approved = true;
          break;
        }
      }

      log(`Still waiting for Duo approval... (${i * 5}s / 120s) [URL: ${currentUrl}]`);
      await new Promise((r) => setTimeout(r, 5000));
    }

    if (!approved && page.url().includes(BASE_URL)) {
      approved = true;
    }

    if (!approved) {
      const finalUrl = page.url();
      const finalBody = await page.evaluate(() =>
        document.body ? document.body.innerText.substring(0, 300) : ""
      );
      throw new Error(
        `Duo authentication timed out. Final URL: ${finalUrl}\nPage content: ${finalBody}`
      );
    }

    log("Authentication successful!");
  } catch (err) {
    throw new Error(`Login failed: ${err.message}`);
  }
}

async function scrapeAvailableRooms(page, date, startTime, endTime) {
  // Booked Scheduler typically shows a table/grid with resources as rows
  // and time slots as columns. Available slots are clickable.
  const rooms = await page.evaluate(
    (startTime, endTime) => {
      const results = [];

      // Strategy 1: Look for resource rows in the schedule table
      const resourceRows = document.querySelectorAll(
        ".resourceName, .resource-name, td.resourceName, [data-resourceid]"
      );

      resourceRows.forEach((row) => {
        const name =
          row.textContent?.trim() ||
          row.getAttribute("data-resourcename") ||
          "";
        const resourceId =
          row.getAttribute("data-resourceid") ||
          row.closest("[data-resourceid]")?.getAttribute("data-resourceid") ||
          "";

        if (name) {
          // Check if the time slot is available (look for reservable slots)
          const scheduleRow = row.closest("tr") || row.parentElement;
          const slots = scheduleRow
            ? scheduleRow.querySelectorAll(
                '.reservable, .unreserved, td[data-start], .slot.open, a[href*="reservation"]'
              )
            : [];

          const isAvailable = slots.length > 0;
          if (isAvailable) {
            results.push({
              name,
              resourceId,
              available: true,
            });
          }
        }
      });

      // Strategy 2: If no resources found with Strategy 1, look for any
      // clickable reservation slots
      if (results.length === 0) {
        const allSlots = document.querySelectorAll(
          'td.reservable, td.unreserved, a.reservable, [data-href*="reservation"], .slot'
        );
        const seenResources = new Set();

        allSlots.forEach((slot) => {
          const resourceName =
            slot.getAttribute("data-resourcename") ||
            slot.closest("tr")?.querySelector(".resourceName")?.textContent?.trim() ||
            slot.getAttribute("title") ||
            "";

          if (resourceName && !seenResources.has(resourceName)) {
            seenResources.add(resourceName);
            results.push({
              name: resourceName,
              resourceId:
                slot.getAttribute("data-resourceid") || "",
              available: true,
            });
          }
        });
      }

      return results;
    },
    startTime,
    endTime
  );

  return rooms;
}

async function clickAndBook(page, room, startTime, endTime, log) {
  log(`Attempting to book ${room.name}...`);

  // Try to click on the room's time slot to open the reservation dialog
  const booked = await page.evaluate(
    (roomName, startTime) => {
      // Find the row for this room
      const allElements = document.querySelectorAll(
        ".resourceName, [data-resourcename]"
      );
      for (const el of allElements) {
        const name =
          el.textContent?.trim() || el.getAttribute("data-resourcename") || "";
        if (name.toLowerCase().includes(roomName.toLowerCase())) {
          // Find the closest reservable slot in this row
          const row = el.closest("tr") || el.parentElement;
          if (row) {
            const slot = row.querySelector(
              '.reservable, .unreserved, td[data-start], a[href*="reservation"]'
            );
            if (slot) {
              slot.click();
              return true;
            }
          }
        }
      }
      return false;
    },
    room.name,
    startTime
  );

  if (!booked) {
    throw new Error(
      `Could not find clickable slot for ${room.name}. The page structure may have changed.`
    );
  }

  // Wait for reservation dialog/form to appear
  log("Reservation form opening...");
  await page.waitForSelector(
    '#reservation-form, .reservation-dialog, [id*="reservation"], form[action*="reservation"], .modal',
    { timeout: 15000 }
  );

  // Fill in the time fields
  log("Setting reservation times...");

  // Try to set start time
  const startInput = await page.$(
    'input[id*="BeginTime"], input[name*="beginTime"], input[id*="startTime"], #BeginTime, #startTime'
  );
  if (startInput) {
    await startInput.click({ clickCount: 3 });
    await startInput.type(startTime);
  }

  // Try to set end time
  const endInput = await page.$(
    'input[id*="EndTime"], input[name*="endTime"], input[id*="endTime"], #EndTime, #endTime'
  );
  if (endInput) {
    await endInput.click({ clickCount: 3 });
    await endInput.type(endTime);
  }

  // Click submit/book button
  log("Submitting reservation...");
  const submitBtn = await page.$(
    'button[type="submit"], input[type="submit"], .btn-primary, #btnSubmit, .save, button.save'
  );
  if (submitBtn) {
    await submitBtn.click();
  }

  // Wait for confirmation
  await page.waitForTimeout(3000);

  // Check for success message
  const success = await page.evaluate(() => {
    const body = document.body.innerText.toLowerCase();
    return (
      body.includes("successfully") ||
      body.includes("confirmed") ||
      body.includes("booked") ||
      body.includes("created")
    );
  });

  if (!success) {
    log(
      "Could not confirm booking success. Please check the browser window."
    );
  } else {
    log("Reservation confirmed!");
  }
}

function parseCookieString(cookieStr, baseUrl) {
  const domain = new URL(baseUrl).hostname;
  return cookieStr.split(";").map((pair) => {
    const [name, ...rest] = pair.trim().split("=");
    return {
      name: name.trim(),
      value: rest.join("=").trim(),
      domain,
      path: "/",
    };
  });
}

module.exports = { bookRoom, KNOWN_ROOMS };
