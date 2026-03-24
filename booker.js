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

  const browser = await puppeteer.launch({
    headless: false, // visible so user can approve Duo
    defaultViewport: null,
    args: ["--start-maximized"],
  });

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

    // Now we should be on the schedule page
    log("Waiting for schedule page to load...");
    await page.waitForSelector("#reservations, .schedule, table, .reservations", {
      timeout: 120000,
    });

    log("Schedule loaded. Looking for available rooms...");

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

    // Click login/submit button
    const submitBtn = await page.$(
      'button[type="submit"], input[type="submit"], button[name="submit"], .btn-submit, #submit'
    );
    if (submitBtn) {
      await submitBtn.click();
    } else {
      await page.keyboard.press("Enter");
    }

    log("Credentials submitted. Waiting for Duo authentication...");
    log(">>> Please approve the Duo push on your phone <<<");

    // Wait for Duo to complete - either we get redirected back to scheduling
    // or we see the Duo iframe
    await page.waitForFunction(
      (baseUrl) => {
        return (
          window.location.href.includes(baseUrl) ||
          document.querySelector('iframe[id="duo_iframe"]') ||
          document.querySelector("#duo-frame") ||
          document.querySelector(".duo-wrapper")
        );
      },
      { timeout: 15000 },
      BASE_URL
    ).catch(() => {});

    // If Duo iframe is present, we need to wait for user to approve
    const duoFrame = await page.$(
      'iframe[id="duo_iframe"], #duo-frame, iframe[src*="duosecurity"]'
    );
    if (duoFrame) {
      log("Duo authentication frame detected. Waiting for approval...");

      // Try to auto-click "Send Me a Push" inside Duo iframe
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

    // Wait until we're redirected back to the scheduling site
    log("Waiting for authentication to complete (up to 2 minutes)...");
    await page.waitForFunction(
      (baseUrl) => window.location.href.includes(baseUrl),
      { timeout: 120000 },
      BASE_URL
    );

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
