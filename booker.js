const puppeteer = require("puppeteer");

const BASE_URL = "https://scheduling.tools.lib.utah.edu";
const SCHEDULE_URL = (date) =>
  `${BASE_URL}/Web/schedule.php?sd=${date}`;

// In-memory session cookie cache
let cachedCookies = null;
let cookieTimestamp = 0;
const COOKIE_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

function getCachedCookies() {
  if (cachedCookies && Date.now() - cookieTimestamp < COOKIE_MAX_AGE_MS) {
    return cachedCookies;
  }
  cachedCookies = null;
  return null;
}

function saveCookies(cookies) {
  cachedCookies = cookies;
  cookieTimestamp = Date.now();
}

function clearCookies() {
  cachedCookies = null;
  cookieTimestamp = 0;
}

function getLaunchOpts() {
  const isServer = process.env.DEPLOYED === "true";
  const opts = {
    headless: isServer ? "new" : false,
    defaultViewport: isServer ? { width: 1280, height: 900 } : null,
    args: isServer
      ? ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
      : ["--start-maximized"],
  };
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    opts.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  return opts;
}

// Navigate to a target URL, using cached cookies if available.
// If redirected to login, performs CAS+Duo auth and caches the new cookies.
// Returns { page, browser } with the page on the target URL.
async function launchAndAuth(targetUrl, username, password, log) {
  const browser = await puppeteer.launch(getLaunchOpts());
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);

  // Try cached cookies first
  const cookies = getCachedCookies();
  if (cookies) {
    log("Using cached session cookies...");
    await page.setCookie(...cookies);
  }

  await page.goto(targetUrl, { waitUntil: "networkidle2" });

  const currentUrl = page.url();
  const needsLogin =
    currentUrl.includes("cas.utah.edu") ||
    currentUrl.includes("login") ||
    currentUrl.includes("go.utah.edu");

  if (needsLogin) {
    if (cookies) {
      log("Cached session expired. Re-authenticating...");
      clearCookies();
    }
    if (!username || !password) {
      throw new Error("Login required but no credentials provided.");
    }
    log("Login page detected. Entering credentials...");
    await handleCASLogin(page, username, password, log);

    // Save cookies after successful auth
    const newCookies = await page.cookies();
    saveCookies(newCookies);
    log("Session cookies cached for future requests.");
  } else {
    log("Authenticated via cached session.");
  }

  return { page, browser };
}

// Known study rooms at Marriott Library
const KNOWN_ROOMS = [
  "2130A Study Room",
  "2130B Study Room",
  "2130C Study Room",
  "2130D Study Room",
  "2130E Study Room",
  "2130F Study Room",
  "2130G Study Room",
  "2130H Study Room",
  "2130J Study Room",
  "2130K Study Room",
  "2130L Study Room",
  "2130M Study Room",
  "2130P Study Room",
  "2130Q Study Room",
  "2130R Study Room",
  "2130S Study Room",
  "2130U Study Room",
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

  log(`Navigating to schedule for ${date}...`);
  const { page, browser } = await launchAndAuth(
    SCHEDULE_URL(date),
    username,
    password,
    log
  );

  try {
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

    // Scrape available rooms and time slots
    const availableRooms = await scrapeAvailableRooms(page, date, startTime, endTime, log);

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

async function scrapeAvailableRooms(page, date, startTime, endTime, log) {
  // The schedule page is a grid: header row has time labels, each room row
  // has td cells with colspan indicating how many 10-min slots they span.
  // Cell classes indicate status: "reservable", "reserved", "unreservable", etc.
  const rooms = await page.evaluate(
    (startTime, endTime) => {
      const results = [];

      // Parse the header row to build a time-to-column mapping
      // Each td in the header has a time label and a colspan
      const tables = document.querySelectorAll("table");
      let scheduleTable = null;
      for (const table of tables) {
        // The schedule table has the time header row
        const headerCells = table.querySelectorAll("tr:first-child td, tr:first-child th");
        for (const cell of headerCells) {
          if (cell.textContent?.includes("AM") || cell.textContent?.includes("PM")) {
            scheduleTable = table;
            break;
          }
        }
        if (scheduleTable) break;
      }

      if (!scheduleTable) return results;

      // Build column index mapping: figure out what column index each time starts at
      // by walking header cells and tracking colspan
      const headerRow = scheduleTable.querySelector("tr");
      const headerCells = headerRow ? headerRow.querySelectorAll("td, th") : [];
      const timeColumns = []; // array of { time: "HH:MM", colStart, colEnd }
      let colIdx = 0;

      for (const cell of headerCells) {
        const colspan = parseInt(cell.getAttribute("colspan") || "1", 10);
        const text = cell.textContent?.trim() || "";

        // Parse time from header like "7:00 AM", "12:00 PM"
        const timeMatch = text.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (timeMatch) {
          let hours = parseInt(timeMatch[1], 10);
          const mins = parseInt(timeMatch[2], 10);
          const ampm = timeMatch[3].toUpperCase();
          if (ampm === "PM" && hours !== 12) hours += 12;
          if (ampm === "AM" && hours === 12) hours = 0;
          const time24 = `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
          timeColumns.push({ time: time24, colStart: colIdx, colEnd: colIdx + colspan });
        }

        colIdx += colspan;
      }

      if (timeColumns.length === 0) return results;

      // Determine the total number of columns
      const totalCols = colIdx;

      // Figure out the column range for the requested start/end time
      // Each column represents a 10-minute slot
      // Find the first header time <= startTime and last header time >= endTime
      function timeToMinutes(t) {
        const [h, m] = t.split(":").map(Number);
        return h * 60 + m;
      }

      const startMins = timeToMinutes(startTime);
      const endMins = timeToMinutes(endTime);

      // Calculate columns per minute based on header
      // Assume 10-min slots (6 columns per hour)
      const firstTime = timeColumns[0];
      const firstMins = timeToMinutes(firstTime.time);
      const slotsPerMin = 1 / 10; // 1 column = 10 minutes
      const startCol = firstTime.colStart + Math.round((startMins - firstMins) * slotsPerMin);
      const endCol = firstTime.colStart + Math.round((endMins - firstMins) * slotsPerMin);

      // Now check each room row
      const rows = scheduleTable.querySelectorAll("tr");
      for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        const cells = row.querySelectorAll("td, th");

        // First cell(s) are usually the room name and a "Library Closed" label
        // Find the room link
        const roomLink = row.querySelector('a[href*="reservation.php"]');
        if (!roomLink) continue;

        const name = roomLink.textContent?.trim();
        if (!name) continue;
        // Only include study rooms
        if (!name.toLowerCase().includes("room") && !name.toLowerCase().includes("study")) continue;

        const href = roomLink.href;
        const ridMatch = href.match(/rid=(\d+)/);
        const rid = ridMatch ? ridMatch[1] : "";

        // Walk the cells tracking column position to check the requested range
        let cellCol = 0;
        let allReservable = true;
        let hasOverlap = false;

        for (const cell of cells) {
          const colspan = parseInt(cell.getAttribute("colspan") || "1", 10);
          const cellStart = cellCol;
          const cellEnd = cellCol + colspan;

          // Check if this cell overlaps with requested time range
          if (cellEnd > startCol && cellStart < endCol) {
            hasOverlap = true;
            const cellClass = (cell.className || "").toLowerCase();
            // "reservable" = open slot, anything else (reserved, unreservable, restricted, past) = not available
            if (!cellClass.includes("reservable") || cellClass.includes("unreservable")) {
              allReservable = false;
              break;
            }
          }

          cellCol += colspan;
        }

        results.push({
          name,
          resourceId: rid,
          href,
          available: hasOverlap && allReservable,
        });
      }

      return results;
    },
    startTime,
    endTime
  );

  const available = rooms.filter((r) => r.available);
  const unavailable = rooms.filter((r) => !r.available);

  if (log) {
    log(`Found ${rooms.length} rooms total: ${available.length} available, ${unavailable.length} unavailable for ${startTime}-${endTime}`);
    if (unavailable.length > 0) {
      log(`Unavailable: ${unavailable.map((r) => r.name).join(", ")}`);
    }
  }

  return available;
}

async function clickAndBook(page, room, startTime, endTime, log) {
  log(`Attempting to book ${room.name} (rid=${room.resourceId})...`);

  // Navigate directly to the reservation page for this room
  const reservationUrl = room.href;
  log(`Navigating to reservation page: ${reservationUrl}`);
  await page.goto(reservationUrl, { waitUntil: "networkidle2" });

  log(`Reservation page loaded. URL: ${page.url()}`);

  // Log the form structure so we know what fields exist
  const formDebug = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input, select, textarea"));
    return inputs.slice(0, 20).map((el) => ({
      tag: el.tagName,
      type: el.type,
      name: el.name,
      id: el.id,
      value: el.value,
      placeholder: el.placeholder,
    }));
  });
  log(`Form fields: ${JSON.stringify(formDebug)}`);

  // Log buttons
  const formButtons = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button, input[type='submit']"));
    return btns.map((b) => ({
      text: b.textContent?.trim(),
      type: b.type,
      name: b.name,
      id: b.id,
      className: b.className,
    }));
  });
  log(`Form buttons: ${JSON.stringify(formButtons)}`);

  // Set start time via BeginPeriod select dropdown (value format: "HH:MM:00")
  const startValue = `${startTime}:00`;
  await page.select("#BeginPeriod", startValue);
  log(`Set start time to ${startTime}`);

  // Set end time via EndPeriod select dropdown
  const endValue = `${endTime}:00`;
  await page.select("#EndPeriod", endValue);
  log(`Set end time to ${endTime}`);

  // Fill required custom attribute fields
  // These are labeled fields like "Class Size (required)", "Name (required)", etc.
  const customFields = {
    "class size": "1",
    "department": "1",
    "name": "aaron",
    "e-mail": "heoaaron@gmail.com",
    "email": "heoaaron@gmail.com",
  };

  const filledFields = await page.evaluate((fields) => {
    const filled = [];
    // Find all labels and match to their inputs
    const labels = document.querySelectorAll("label");
    for (const label of labels) {
      const labelText = (label.textContent || "").toLowerCase().replace(/\(.*?\)/g, "").trim();
      for (const [key, value] of Object.entries(fields)) {
        if (labelText.includes(key)) {
          // Find the associated input via 'for' attribute or next sibling
          const inputId = label.getAttribute("for");
          let input = inputId ? document.getElementById(inputId) : null;
          if (!input) {
            input = label.parentElement?.querySelector("input, select, textarea");
          }
          if (!input) {
            input = label.nextElementSibling;
          }
          if (input && (input.tagName === "INPUT" || input.tagName === "TEXTAREA")) {
            input.value = value;
            input.dispatchEvent(new Event("change", { bubbles: true }));
            input.dispatchEvent(new Event("input", { bubbles: true }));
            filled.push(`${key} = ${value}`);
          } else if (input && input.tagName === "SELECT") {
            // Try to select matching option
            for (const opt of input.options) {
              if (opt.text.toLowerCase().includes(value.toLowerCase()) || opt.value === value) {
                input.value = opt.value;
                input.dispatchEvent(new Event("change", { bubbles: true }));
                filled.push(`${key} = ${opt.text}`);
                break;
              }
            }
          }
          break;
        }
      }
    }
    return filled;
  }, customFields);

  log(`Filled custom fields: ${filledFields.join(", ") || "none found"}`);

  // Click the "Create" button (type="button", class="button save create")
  log("Submitting reservation...");
  const createBtn = await page.$("button.save.create");
  if (createBtn) {
    await createBtn.evaluate((btn) => btn.click());
    // Wait for the response (AJAX-based, not a page navigation)
    await new Promise((r) => setTimeout(r, 5000));
  } else {
    log("Could not find Create button!");
  }

  // Check for success or error messages on the page
  const result = await page.evaluate(() => {
    const body = document.body.innerText;
    const success =
      body.includes("successfully") ||
      body.includes("confirmed") ||
      body.includes("booked") ||
      body.includes("created") ||
      body.includes("Created");
    const errors = [];
    const errorEls = document.querySelectorAll(".error, .alert-danger, .validation-error, .alert, .reservationError, #reservation-error");
    errorEls.forEach((el) => {
      const text = el.textContent?.trim();
      if (text) errors.push(text);
    });
    // Also check for inline validation errors
    const validationEls = document.querySelectorAll(".inlineError, .inline-error, span.error");
    validationEls.forEach((el) => {
      const text = el.textContent?.trim();
      if (text) errors.push(text);
    });
    return { success, errors, bodySnippet: body.substring(0, 500), url: window.location.href };
  });

  if (result.success) {
    log("Reservation confirmed!");
  } else if (result.errors.length > 0) {
    log(`Reservation errors: ${result.errors.join("; ")}`);
  } else {
    log(`Reservation result unclear. Page content: ${result.bodySnippet}`);
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

async function getReservations(opts, onProgress) {
  const { username, password } = opts;

  const log = (msg) => {
    console.log(`[reservations] ${msg}`);
    if (onProgress) onProgress(msg);
  };

  const dashboardUrl = `${BASE_URL}/Web/dashboard.php`;
  log("Navigating to dashboard...");
  const { page, browser } = await launchAndAuth(
    dashboardUrl,
    username,
    password,
    log
  );

  try {
    // After auth, make sure we're on the dashboard
    if (!page.url().includes("dashboard.php")) {
      await page.goto(dashboardUrl, { waitUntil: "networkidle2" });
    }

    log("Dashboard loaded. Scraping reservations...");

    // Scrape the "Upcoming Reservations" table
    const reservations = await page.evaluate(() => {
      const results = [];
      // Find all table rows in the upcoming reservations section
      const tables = document.querySelectorAll("table");
      for (const table of tables) {
        const rows = table.querySelectorAll("tr");
        for (const row of rows) {
          const cells = row.querySelectorAll("td");
          if (cells.length >= 4) {
            const title = cells[0]?.textContent?.trim();
            const user = cells[1]?.textContent?.trim();
            const startDate = cells[2]?.textContent?.trim();
            const endDate = cells[3]?.textContent?.trim();
            const room = cells[4]?.textContent?.trim() || "";
            if (title && startDate) {
              results.push({ title, user, startDate, endDate, room });
            }
          }
        }
      }
      return results;
    });

    log(`Found ${reservations.length} reservation(s).`);
    await browser.close();
    return { success: true, reservations };
  } catch (err) {
    log(`Error: ${err.message}`);
    await browser.close().catch(() => {});
    throw err;
  }
}

module.exports = { bookRoom, getReservations, KNOWN_ROOMS };
