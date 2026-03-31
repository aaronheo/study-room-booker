const puppeteer = require("puppeteer");

const BASE_URL = "https://scheduling.tools.lib.utah.edu";
const SCHEDULE_URL = (date, sid) =>
  `${BASE_URL}/Web/schedule.php?sd=${date}${sid ? `&sid=${sid}` : ""}`;

function getNextFriday() {
  const today = new Date();
  const day = today.getDay(); // 0=Sun, 5=Fri
  const daysUntilFri = (5 - day + 7) % 7 || 7;
  const fri = new Date(today);
  fri.setDate(today.getDate() + daysUntilFri);
  return fri.toISOString().split("T")[0]; // YYYY-MM-DD
}

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
async function launchAndAuth(targetUrl, username, password, log, debug) {
  const browser = await puppeteer.launch(getLaunchOpts());
  const page = await browser.newPage();
  page.setDefaultTimeout(120000);

  // Try cached cookies first
  const cookies = getCachedCookies();
  if (cookies) {
    log("Using cached session cookies...");
    await page.setCookie(...cookies);
  }

  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Without cached cookies, wait briefly for possible CAS redirect
  if (!cookies) {
    await new Promise((r) => setTimeout(r, 2000));
  }

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
    await handleCASLogin(page, username, password, log, debug);

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
    date = getNextFriday(),
    startTime = "11:00",
    endTime = "14:00",
    room = "2130S Study room",
  } = opts;

  const log = (msg) => {
    console.log(`[booker] ${msg}`);
    if (onProgress) onProgress(msg);
  };
  const debug = (msg) => console.log(`[booker:debug] ${msg}`);

  log(`Navigating to schedule for ${date}...`);
  const { page, browser } = await launchAndAuth(
    SCHEDULE_URL(date),
    username,
    password,
    log,
    debug
  );

  try {
    // After auth, we may land on dashboard instead of schedule - navigate there
    if (!page.url().includes("schedule.php")) {
      debug(`Landed on ${page.url()} after auth. Navigating to schedule...`);
      await page.goto(SCHEDULE_URL(date), { waitUntil: "domcontentloaded", timeout: 60000 });
    }

    debug(`On schedule page. URL: ${page.url()}`);
    log("Waiting for schedule rooms to load...");
    try {
      await page.waitForSelector('a[href*="reservation.php"]', {
        timeout: 30000,
      });
    } catch {
      const pageTitle = await page.title();
      const bodySnippet = await page.evaluate(() =>
        document.body ? document.body.innerHTML.substring(0, 500) : "no body"
      );
      debug(`Page title: ${pageTitle}`);
      debug(`Page HTML snippet: ${bodySnippet}`);
      throw new Error(
        "Schedule page did not load expected selectors. See logs above for page content."
      );
    }

    log("Schedule loaded. Looking for available rooms...");

    // Scrape available rooms and time slots
    const availableRooms = await scrapeAvailableRooms(page, date, startTime, endTime, log, debug);

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
      const booked = await clickAndBook(page, preferredRoom, date, startTime, endTime, log, debug);
      await browser.close();
      if (booked) {
        return {
          success: true,
          message: `Successfully booked ${preferredRoom.name} from ${startTime} to ${endTime} on ${date}`,
          bookedRoom: preferredRoom.name,
        };
      } else {
        return {
          success: false,
          message: `Failed to book ${preferredRoom.name}. See errors above.`,
        };
      }
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
    await browser.close().catch(() => {});
    throw err;
  }
}

async function handleCASLogin(page, username, password, log, debug) {
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
    debug("Username entered.");

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
    debug("Password entered.");

    // Click login/submit button and wait for navigation to Duo
    const submitBtn = await page.$(
      'button[type="submit"], input[type="submit"], button[name="submit"], .btn-submit, #submit'
    );

    debug("Submitting credentials...");
    // Use Promise.all to click and wait for navigation simultaneously
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }).catch(() => {}),
      submitBtn ? submitBtn.click() : page.keyboard.press("Enter"),
    ]);

    log("Credentials submitted. Waiting for Duo authentication...");
    log(">>> Please approve the Duo push on your phone <<<");

    let currentUrl = page.url();
    debug(`After credentials, current URL: ${currentUrl}`);

    // Check for Duo iframe (legacy Duo)
    const duoFrame = await page.$(
      'iframe[id="duo_iframe"], #duo-frame, iframe[src*="duosecurity"]'
    );
    if (duoFrame) {
      debug("Duo iframe detected. Trying to auto-click push...");
      try {
        const frame = await duoFrame.contentFrame();
        if (frame) {
          const pushBtn = await frame.$(
            'button.auth-button.positive, button[type="submit"]'
          );
          if (pushBtn) {
            await pushBtn.click();
            debug("Auto-clicked 'Send Me a Push'.");
          }
        }
      } catch {
        debug("Could not auto-click Duo push.");
      }
    }

    // Check for Duo Universal Prompt (redirect-based, not iframe)
    currentUrl = page.url();
    if (currentUrl.includes("duosecurity.com") || currentUrl.includes("duo.com")) {
      debug("Duo Universal Prompt detected. Waiting for page to fully load...");

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
      debug(`Duo page buttons: ${JSON.stringify(buttons)}`);

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
        debug(`Auto-clicked Duo button: "${clicked}".`);
      } else {
        debug("Could not find a push button on Duo page.");
      }
    }

    // Poll every 5 seconds for Duo approval (up to 2 minutes)
    log("Waiting for Duo approval...");
    log("duo_approval_needed");
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
          debug(`Duo approved! State: success=${duoState.hasSuccess}, trustPrompt=${duoState.hasTrustPrompt}`);
          debug(`Buttons on page: ${JSON.stringify(duoState.btnTexts)}`);

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
          debug(`After clicking trust/continue, URL: ${page.url()}`);
        }

        if (i % 4 === 0) {
          debug(`Duo page body: ${duoState.bodySnippet}`);
        }
      }

      // If we've left Duo/CAS, we might be mid-redirect
      const onDuoOrCas =
        currentUrl.includes("duosecurity.com") ||
        currentUrl.includes("duo.com") ||
        currentUrl.includes("cas.utah.edu");
      if (!onDuoOrCas) {
        debug(`No longer on Duo/CAS. URL: ${currentUrl}`);
        await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 }).catch(() => {});
        if (page.url().includes(BASE_URL)) {
          approved = true;
          break;
        }
      }

      debug(`Still waiting for Duo approval... (${i * 5}s / 120s) [URL: ${currentUrl}]`);
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

async function scrapeScheduleIds(page, debug) {
  // Detect all available schedule IDs from the page
  const scheduleIds = await page.evaluate(() => {
    const ids = new Set();

    // Check for schedule selector dropdown (Booked Scheduler uses #schedules or similar)
    const scheduleSel = document.querySelector('select#schedules, select[name*="schedule"], select.schedule-select');
    if (scheduleSel) {
      for (const opt of scheduleSel.options) {
        if (opt.value && /^\d+$/.test(opt.value)) {
          ids.add(opt.value);
        }
      }
    }

    // Check for schedule links/tabs containing sid=
    const links = document.querySelectorAll('a[href*="sid="]');
    for (const link of links) {
      const match = link.href.match(/sid=(\d+)/);
      if (match) {
        ids.add(match[1]);
      }
    }

    // Check current URL for sid parameter
    const urlParams = new URLSearchParams(location.search);
    const currentSid = urlParams.get('sid');
    if (currentSid) ids.add(currentSid);

    return Array.from(ids);
  });

  if (debug) {
    debug(`Found schedule IDs on page: ${JSON.stringify(scheduleIds)}`);
  }

  return scheduleIds;
}

function scrapeCurrentPageRooms(startTime, endTime) {
  // This runs inside page.evaluate - scrapes rooms from the currently loaded schedule
  const results = [];

  const tables = document.querySelectorAll("table");
  let scheduleTable = null;
  for (const table of tables) {
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

  const headerRow = scheduleTable.querySelector("tr");
  const headerCells = headerRow ? headerRow.querySelectorAll("td, th") : [];
  const timeColumns = [];
  let colIdx = 0;

  for (const cell of headerCells) {
    const colspan = parseInt(cell.getAttribute("colspan") || "1", 10);
    const text = cell.textContent?.trim() || "";

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

  function timeToMinutes(t) {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  }

  const startMins = timeToMinutes(startTime);
  const endMins = timeToMinutes(endTime);

  const firstTime = timeColumns[0];
  const firstMins = timeToMinutes(firstTime.time);
  const slotsPerMin = 1 / 10;
  const startCol = firstTime.colStart + Math.round((startMins - firstMins) * slotsPerMin);
  const endCol = firstTime.colStart + Math.round((endMins - firstMins) * slotsPerMin);

  const rows = scheduleTable.querySelectorAll("tr");
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];

    const roomLink = row.querySelector('a[href*="reservation.php"]');
    if (!roomLink) continue;

    const name = roomLink.textContent?.trim();
    if (!name) continue;
    if (!name.startsWith("2130")) continue;

    const href = roomLink.href;
    const ridMatch = href.match(/rid=(\d+)/);
    const rid = ridMatch ? ridMatch[1] : "";

    let cellCol = 0;
    let allReservable = true;
    let hasOverlap = false;
    let slotHref = "";

    const cells = row.querySelectorAll("td, th");
    for (const cell of cells) {
      const colspan = parseInt(cell.getAttribute("colspan") || "1", 10);
      const cellStart = cellCol;
      const cellEnd = cellCol + colspan;

      if (cellEnd > startCol && cellStart < endCol) {
        hasOverlap = true;
        const cellClass = (cell.className || "").toLowerCase();
        if (!cellClass.includes("reservable") || cellClass.includes("unreservable")) {
          allReservable = false;
          break;
        }
        // Capture the reservation URL from a reservable time slot cell
        // These cells typically have links or data attributes with the date baked in
        if (!slotHref) {
          const slotLink = cell.querySelector("a[href*='reservation.php']");
          if (slotLink) {
            slotHref = slotLink.href;
          } else if (cell.getAttribute("data-href")) {
            slotHref = cell.getAttribute("data-href");
          }
        }
      }

      cellCol += colspan;
    }

    results.push({
      name,
      resourceId: rid,
      href: slotHref || href,
      available: hasOverlap && allReservable,
    });
  }

  return results;
}

async function scrapeAvailableRooms(page, date, startTime, endTime, log, debug) {
  // The schedule page is a grid: header row has time labels, each room row
  // has td cells with colspan indicating how many 10-min slots they span.
  // Cell classes indicate status: "reservable", "reserved", "unreservable", etc.

  // Scrape rooms from the current schedule page
  let allRooms = await page.evaluate(scrapeCurrentPageRooms, startTime, endTime);

  // Check if the page has other schedule tabs/links with different rooms
  const scheduleIds = await scrapeScheduleIds(page, debug);

  if (scheduleIds.length > 1) {
    const seenRids = new Set(allRooms.map(r => r.resourceId));

    for (const sid of scheduleIds) {
      if (page.url().includes(`sid=${sid}`)) continue;

      if (debug) debug(`Checking schedule ${sid} for additional rooms...`);

      try {
        await page.goto(SCHEDULE_URL(date, sid), { waitUntil: "domcontentloaded", timeout: 30000 });
        await page.waitForSelector('a[href*="reservation.php"]', { timeout: 10000 }).catch(() => {});

        const moreRooms = await page.evaluate(scrapeCurrentPageRooms, startTime, endTime);

        for (const room of moreRooms) {
          if (!seenRids.has(room.resourceId)) {
            seenRids.add(room.resourceId);
            allRooms.push(room);
          }
        }
      } catch (err) {
        if (debug) debug(`Failed to load schedule ${sid}: ${err.message}`);
      }
    }
  }

  const available = allRooms.filter((r) => r.available);
  const unavailable = allRooms.filter((r) => !r.available);

  if (log) {
    log(`Found ${allRooms.length} rooms total: ${available.length} available, ${unavailable.length} unavailable for ${startTime}-${endTime}`);
    if (unavailable.length > 0) {
      log(`Unavailable: ${unavailable.map((r) => r.name).join(", ")}`);
    }
  }

  return available;
}

async function clickAndBook(page, room, date, startTime, endTime, log, debug) {
  log(`Booking ${room.name} for ${date}...`);

  // Ensure the reservation URL includes the date (rd parameter)
  let reservationUrl = room.href;
  if (!reservationUrl.includes("rd=")) {
    const separator = reservationUrl.includes("?") ? "&" : "?";
    reservationUrl = `${reservationUrl}${separator}rd=${date}`;
  }
  debug(`Navigating to reservation page: ${reservationUrl}`);
  await page.goto(reservationUrl, { waitUntil: "networkidle2" });

  debug(`Reservation page loaded. URL: ${page.url()}`);

  // Set the reservation title - try multiple selectors
  const titleSet = await page.evaluate(() => {
    // Try by ID first
    const byId = document.getElementById("reservationTitle");
    if (byId) {
      byId.value = "Study";
      byId.dispatchEvent(new Event("change", { bubbles: true }));
      byId.dispatchEvent(new Event("input", { bubbles: true }));
      return "by id: reservationTitle";
    }
    // Try by name
    const byName = document.querySelector('input[name="reservationTitle"], textarea[name="reservationTitle"]');
    if (byName) {
      byName.value = "Study";
      byName.dispatchEvent(new Event("change", { bubbles: true }));
      byName.dispatchEvent(new Event("input", { bubbles: true }));
      return "by name: reservationTitle";
    }
    // Try finding by label text
    const labels = document.querySelectorAll("label");
    for (const label of labels) {
      const text = (label.textContent || "").toLowerCase();
      if (text.includes("title")) {
        const inputId = label.getAttribute("for");
        let input = inputId ? document.getElementById(inputId) : null;
        if (!input) input = label.parentElement?.querySelector("input, textarea");
        if (!input) input = label.nextElementSibling;
        if (input && (input.tagName === "INPUT" || input.tagName === "TEXTAREA")) {
          input.value = "Study";
          input.dispatchEvent(new Event("change", { bubbles: true }));
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return `by label: ${label.textContent.trim()} -> ${input.tagName}#${input.id}`;
        }
      }
    }
    // List all inputs with title-related attributes for debugging
    const allInputs = Array.from(document.querySelectorAll("input, textarea"));
    const titleRelated = allInputs.filter(el =>
      (el.name + el.id + el.placeholder).toLowerCase().includes("title")
    ).map(el => `${el.tagName}#${el.id}[name=${el.name}]`);
    return `not found. Title-related inputs: ${titleRelated.join(", ") || "none"}`;
  });
  debug(`Reservation title: ${titleSet}`);

  // Set the reservation date on the form
  const [year, month, day] = date.split("-");
  const dateFormats = {
    iso: date, // 2026-04-10
    slashed: `${month.padStart(2, "0")}/${day.padStart(2, "0")}/${year}`, // 04/10/2026
    unpadded: `${parseInt(month)}/${parseInt(day)}/${year}`, // 4/10/2026
  };
  const dateResult = await page.evaluate((formats) => {
    // First, discover all date-related inputs on the form
    const allInputs = Array.from(document.querySelectorAll("input"));
    const dateInputs = allInputs.filter(el => {
      const id = (el.id || "").toLowerCase();
      const name = (el.name || "").toLowerCase();
      const type = (el.type || "").toLowerCase();
      return type === "date" || id.includes("date") || name.includes("date");
    });

    const report = { found: [], set: [], allDateInputs: [] };

    // Log all date inputs for debugging
    for (const el of dateInputs) {
      report.allDateInputs.push({
        id: el.id, name: el.name, type: el.type, value: el.value,
        className: el.className, readOnly: el.readOnly
      });
    }

    // Set date on each date input we find
    for (const el of dateInputs) {
      const currentVal = el.value;
      let newVal;
      // Match the existing format
      if (currentVal.includes("/")) {
        // Could be M/D/YYYY or MM/DD/YYYY — check padding
        const parts = currentVal.split("/");
        if (parts[0] && parts[0].length === 1) {
          newVal = formats.unpadded;
        } else {
          newVal = formats.slashed;
        }
      } else if (currentVal.includes("-")) {
        newVal = formats.iso;
      } else {
        // Try all formats
        newVal = formats.slashed;
      }

      el.value = newVal;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      // Trigger blur to ensure any date picker updates
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      report.set.push(`${el.id || el.name}: "${currentVal}" -> "${newVal}"`);
    }

    return report;
  }, dateFormats);
  log(`Date fields: ${dateResult.set.length > 0 ? dateResult.set.join(", ") : "none found"}`);
  debug(`All date inputs on form: ${JSON.stringify(dateResult.allDateInputs)}`);

  // Set start time via BeginPeriod select dropdown (value format: "HH:MM:00")
  const startValue = `${startTime}:00`;
  await page.select("#BeginPeriod", startValue);
  debug(`Set start time to ${startTime}`);

  // Set end time via EndPeriod select dropdown
  const endValue = `${endTime}:00`;
  await page.select("#EndPeriod", endValue);
  debug(`Set end time to ${endTime}`);

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

  debug(`Filled custom fields: ${filledFields.join(", ") || "none found"}`);

  // Click the "Create" button (type="button", class="button save create")
  log("Submitting reservation...");
  const createBtn = await page.$("button.save.create");
  if (createBtn) {
    // Wait for the AJAX response after clicking
    await Promise.all([
      page.waitForResponse(
        (res) => res.url().includes("reservation.php") || res.url().includes("ajax"),
        { timeout: 15000 }
      ).catch(() => {}),
      createBtn.evaluate((btn) => btn.click()),
    ]);
    // Brief pause for DOM to update with response
    await new Promise((r) => setTimeout(r, 1000));
  } else {
    debug("Could not find Create button!");
  }

  // Check for error messages first (errors take priority over false success matches)
  const result = await page.evaluate(() => {
    const errors = [];
    const errorEls = document.querySelectorAll(".error, .alert-danger, .validation-error, .alert, .reservationError, #reservation-error");
    errorEls.forEach((el) => {
      const text = el.textContent?.trim();
      if (text) errors.push(text);
    });
    const validationEls = document.querySelectorAll(".inlineError, .inline-error, span.error");
    validationEls.forEach((el) => {
      const text = el.textContent?.trim();
      if (text) errors.push(text);
    });

    // Only check success if there are no errors
    const body = document.body.innerText;
    const hasSuccess = errors.length === 0 && (
      body.includes("successfully") ||
      body.includes("confirmed") ||
      body.includes("booked")
    );

    return { success: hasSuccess, errors, bodySnippet: body.substring(0, 500) };
  });

  if (result.errors.length > 0) {
    log(`Reservation errors: ${result.errors.join("; ")}`);
    return false;
  } else if (result.success) {
    log("Reservation confirmed!");
    return true;
  } else {
    debug(`Reservation result unclear. Page content: ${result.bodySnippet}`);
    return false;
  }
}

async function getReservations(opts, onProgress) {
  const { username, password } = opts;

  const log = (msg) => {
    console.log(`[reservations] ${msg}`);
    if (onProgress) onProgress(msg);
  };
  const debug = (msg) => console.log(`[reservations:debug] ${msg}`);

  const dashboardUrl = `${BASE_URL}/Web/dashboard.php`;
  log("Loading reservations...");
  const { page, browser } = await launchAndAuth(
    dashboardUrl,
    username,
    password,
    log,
    debug
  );

  try {
    // After auth, make sure we're on the dashboard
    if (!page.url().includes("dashboard.php")) {
      await page.goto(dashboardUrl, { waitUntil: "networkidle2" });
    }

    log("Dashboard loaded. Scraping reservations...");

    // Debug: dump the raw dashboard HTML to understand the structure
    const dashboardDebug = await page.evaluate(() => {
      const tables = document.querySelectorAll("table");
      const info = [];
      for (const table of tables) {
        const rows = table.querySelectorAll("tr");
        const sampleRows = Array.from(rows).slice(0, 3).map(r => r.innerHTML.substring(0, 500));
        info.push({ rowCount: rows.length, sampleRows });
      }
      // Also look for non-table reservation elements
      const reservationEls = document.querySelectorAll("[class*='reservation'], [class*='upcoming'], [id*='reservation'], [id*='upcoming']");
      const reservationInfo = Array.from(reservationEls).slice(0, 3).map(el => ({
        tag: el.tagName, id: el.id, className: el.className,
        html: el.innerHTML.substring(0, 300)
      }));
      // Look for ALL links on the page
      const allLinks = Array.from(document.querySelectorAll("a")).slice(0, 20).map(a => ({
        text: a.textContent?.trim().substring(0, 50), href: a.href
      }));
      return { tables: info, reservationEls: reservationInfo, links: allLinks };
    });
    debug(`Dashboard structure: ${JSON.stringify(dashboardDebug)}`);

    // Scrape the "Upcoming Reservations" table
    const reservations = await page.evaluate(() => {
      const results = [];
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

            // Extract reservation reference number from links in the row
            let referenceNumber = "";
            const links = row.querySelectorAll("a");
            for (const link of links) {
              const href = link.href || "";
              // Try rn= parameter
              const rnMatch = href.match(/rn=([A-Za-z0-9]+)/);
              if (rnMatch) { referenceNumber = rnMatch[1]; break; }
              // Try referenceNumber= parameter
              const refMatch = href.match(/referenceNumber=([A-Za-z0-9]+)/);
              if (refMatch) { referenceNumber = refMatch[1]; break; }
              // Try reservation.php?rid= (resource id as fallback identifier)
              const ridMatch = href.match(/rid=(\d+)/);
              if (ridMatch && href.includes("reservation.php")) {
                referenceNumber = link.href; // store full URL as fallback
                break;
              }
            }
            // Also check data attributes on the row and cells
            if (!referenceNumber) {
              referenceNumber = row.getAttribute("data-refnum") || row.getAttribute("data-rn") ||
                row.getAttribute("data-reservation-id") || "";
            }
            // Check the title cell link specifically (Booked puts the ref link on the title)
            if (!referenceNumber && cells[0]) {
              const titleLink = cells[0].querySelector("a");
              if (titleLink && titleLink.href) {
                referenceNumber = titleLink.href;
              }
            }

            if (title && startDate) {
              results.push({ title, user, startDate, endDate, room, referenceNumber });
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

async function checkAvailability(opts, onProgress) {
  const { username, password, date, startTime, endTime } = opts;

  const log = (msg) => {
    console.log(`[availability] ${msg}`);
    if (onProgress) onProgress(msg);
  };
  const debug = (msg) => console.log(`[availability:debug] ${msg}`);

  log(`Checking availability for ${date} ${startTime}-${endTime}...`);
  const { page, browser } = await launchAndAuth(
    SCHEDULE_URL(date),
    username,
    password,
    log,
    debug
  );

  try {
    if (!page.url().includes("schedule.php")) {
      debug(`Navigating to schedule...`);
      await page.goto(SCHEDULE_URL(date), { waitUntil: "domcontentloaded", timeout: 60000 });
    }

    log("Waiting for schedule rooms to load...");
    await page.waitForSelector('a[href*="reservation.php"]', {
      timeout: 30000,
    });

    const availableRooms = await scrapeAvailableRooms(page, date, startTime, endTime, log, debug);
    await browser.close();

    return {
      success: true,
      availableRooms: availableRooms.map((r) => ({
        name: r.name,
        resourceId: r.resourceId,
      })),
    };
  } catch (err) {
    log(`Error: ${err.message}`);
    await browser.close().catch(() => {});
    throw err;
  }
}

async function deleteReservation(opts, onProgress) {
  const { username, password, referenceNumber } = opts;

  const log = (msg) => {
    console.log(`[delete] ${msg}`);
    if (onProgress) onProgress(msg);
  };
  const debug = (msg) => console.log(`[delete:debug] ${msg}`);

  if (!referenceNumber) {
    throw new Error("No reservation reference number provided.");
  }

  log(`Deleting reservation...`);

  // referenceNumber can be an rn code, a full URL, or a rid
  let reservationUrl;
  if (referenceNumber.startsWith("http")) {
    reservationUrl = referenceNumber;
  } else if (/^\d+$/.test(referenceNumber)) {
    reservationUrl = `${BASE_URL}/Web/reservation.php?rid=${referenceNumber}`;
  } else {
    reservationUrl = `${BASE_URL}/Web/reservation.php?rn=${referenceNumber}`;
  }
  const { page, browser } = await launchAndAuth(
    reservationUrl,
    username,
    password,
    log,
    debug
  );

  try {
    if (!page.url().includes("reservation.php")) {
      await page.goto(reservationUrl, { waitUntil: "networkidle2" });
    }

    debug(`On reservation page. URL: ${page.url()}`);

    // Look for the Delete button
    const deleteBtn = await page.$("button.save.delete, button.delete, .btn-danger, button[class*='delete']");
    if (!deleteBtn) {
      // Try finding by text content
      const btnByText = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button, a.btn"));
        for (const btn of btns) {
          if ((btn.textContent || "").toLowerCase().includes("delete")) {
            btn.click();
            return btn.textContent.trim();
          }
        }
        return null;
      });
      if (!btnByText) {
        throw new Error("Could not find Delete button on reservation page.");
      }
      debug(`Clicked delete button by text: "${btnByText}"`);
    } else {
      await deleteBtn.click();
      debug("Clicked delete button.");
    }

    // Wait for confirmation dialog/modal
    await new Promise((r) => setTimeout(r, 1000));

    // Booked Scheduler shows a confirmation dialog — click the confirm/OK button
    const confirmed = await page.evaluate(() => {
      // Check for modal/dialog confirm buttons
      const confirmBtns = Array.from(document.querySelectorAll(
        ".modal button, .dialog button, #dialogSave, button.save, #btnConfirmDelete, button[id*='confirm'], button[id*='ok']"
      ));
      for (const btn of confirmBtns) {
        const text = (btn.textContent || "").toLowerCase();
        if (text.includes("delete") || text.includes("ok") || text.includes("yes") || text.includes("confirm")) {
          btn.click();
          return text.trim();
        }
      }
      // Also check for any visible primary button in a dialog
      const primary = document.querySelector(".modal-footer .btn-primary, .modal-footer button");
      if (primary) {
        primary.click();
        return primary.textContent?.trim() || "primary";
      }
      return null;
    });

    if (confirmed) {
      debug(`Confirmed deletion: "${confirmed}"`);
    } else {
      debug("No confirmation dialog found, deletion may have proceeded directly.");
    }

    // Wait for response
    await page.waitForResponse(
      (res) => res.url().includes("reservation.php") || res.url().includes("ajax") || res.url().includes("delete"),
      { timeout: 10000 }
    ).catch(() => {});
    await new Promise((r) => setTimeout(r, 1000));

    // Check result
    const result = await page.evaluate(() => {
      const body = document.body?.innerText || "";
      const errors = [];
      document.querySelectorAll(".error, .alert-danger, .validation-error").forEach(el => {
        const text = el.textContent?.trim();
        if (text) errors.push(text);
      });
      const hasSuccess = errors.length === 0 && (
        body.includes("deleted") || body.includes("removed") || body.includes("successfully")
      );
      return { success: hasSuccess, errors, bodySnippet: body.substring(0, 500) };
    });

    await browser.close();

    if (result.errors.length > 0) {
      return { success: false, message: `Delete failed: ${result.errors.join("; ")}` };
    }
    if (result.success) {
      log("Reservation deleted successfully!");
      return { success: true, message: "Reservation deleted successfully." };
    }

    // If we can't confirm success but no errors, assume it worked
    // (the page might have navigated away from the reservation)
    log("Reservation deletion submitted.");
    return { success: true, message: "Reservation deletion submitted." };
  } catch (err) {
    log(`Error: ${err.message}`);
    await browser.close().catch(() => {});
    throw err;
  }
}

module.exports = { bookRoom, getReservations, deleteReservation, checkAvailability, KNOWN_ROOMS, hasCachedSession: () => getCachedCookies() !== null };
