import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Page } from "playwright";

chromium.use(StealthPlugin());

export type Slot = { date: string; time?: string };
export type BookResult = { message: string };

const CALENDAR = '[data-testid="calendar-table"]';

async function launchPage() {
  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== "false",
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-infobars",
      "--disable-gpu",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "America/New_York",
    extraHTTPHeaders: {
      "Accept-Language": "en-US,en;q=0.9",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-User": "?1",
      "Sec-Fetch-Dest": "document",
    },
  });

  const page = await context.newPage();
  return { browser, page };
}

function monthParam(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

async function scrapeMonth(page: Page, url: string, yearMonth: string): Promise<Slot[]> {
  await page.goto(`${url}?month=${yearMonth}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(`${CALENDAR} button:not([disabled])`, { timeout: 15000 });

  const [yyyy, mm] = yearMonth.split("-") as [string, string];

  return page.evaluate(
    ({ sel, yyyy, mm }): Slot[] => {
      const grid = document.querySelector(sel);
      if (!grid) return [];

      const results: Slot[] = [];
      const buttons = grid.querySelectorAll<HTMLButtonElement>(
        'button:not([disabled]):not([aria-disabled="true"])',
      );

      for (const btn of buttons) {
        const text = btn.textContent?.trim() ?? "";
        if (!/^\d{1,2}$/.test(text)) continue;
        const dayNum = parseInt(text, 10);
        if (dayNum < 1 || dayNum > 31) continue;
        results.push({ date: `${yyyy}-${mm}-${String(dayNum).padStart(2, "0")}` });
      }

      return results;
    },
    { sel: CALENDAR, yyyy, mm },
  );
}

export async function listAvailableSlots(date?: string): Promise<Slot[]> {
  const url = process.env.CALENDLY_URL;
  if (!url) throw new Error("CALENDLY_URL is not set");

  const { browser, page } = await launchPage();

  try {
    if (!date) {
      const now = new Date();
      const currentMonth = monthParam(now.getFullYear(), now.getMonth() + 1);
      const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
      const nextMonth = monthParam(next.getFullYear(), next.getMonth() + 1);

      const currentMonthSlots = await scrapeMonth(page, url, currentMonth);
      const nextMonthSlots = await scrapeMonth(page, url, nextMonth);
      return [...currentMonthSlots, ...nextMonthSlots];
    }

    // For a specific date, navigate to its month and click the day
    const [year, month, day] = date.split("-").map(Number) as [number, number, number];
    await page.goto(`${url}?month=${monthParam(year, month)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`${CALENDAR} button:not([disabled])`, { timeout: 15000 });

    await page
      .locator(`${CALENDAR} button:not([disabled])`)
      .filter({ hasText: new RegExp(`^${day}$`) })
      .first()
      .click();

    await page.waitForSelector(
      '[data-testid="time-button"], [role="listitem"] button, [data-component="time-button"]',
      { timeout: 10000 },
    );

    return await page.evaluate((dateStr): Slot[] => {
      const timeButtons = document.querySelectorAll<HTMLElement>(
        '[data-testid="time-button"], [data-component="time-button"], [role="listitem"] button',
      );
      const results: Slot[] = [];
      for (const btn of timeButtons) {
        const text = btn.textContent?.trim() ?? "";
        if (text) results.push({ date: dateStr, time: text });
      }
      return results;
    }, date);
  } finally {
    await browser.close();
  }
}

export async function bookAppointment(
  date: string,
  time: string,
  name: string,
  email: string,
  phone: string,
): Promise<BookResult> {
  const url = process.env.CALENDLY_URL;
  if (!url) throw new Error("CALENDLY_URL is not set");

  const { browser, page } = await launchPage();

  try {
    const [year, month, day] = date.split("-").map(Number) as [number, number, number];
    await page.goto(`${url}?month=${monthParam(year, month)}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`${CALENDAR} button:not([disabled])`, { timeout: 15000 });

    // Click the day
    await page
      .locator(`${CALENDAR} button:not([disabled])`)
      .filter({ hasText: new RegExp(`^${day}$`) })
      .first()
      .click();

    // Wait for time slots to appear
    await page.waitForSelector(
      '[data-testid="time-button"], [role="listitem"] button, [data-component="time-button"]',
      { timeout: 10000 },
    );

    // Find the requested time slot
    const timeButton = page
      .locator(
        '[data-testid="time-button"], [data-component="time-button"], [role="listitem"] button',
      )
      .filter({ hasText: new RegExp(`^${time}$`, "i") })
      .first();

    if ((await timeButton.count()) === 0) {
      await page.screenshot({ path: "debug-unavailable.png" });
      return {
        message: `Time slot "${time}" is no longer available for ${date}. Please call list_available_slots with date="${date}" to get current available times and try again.`,
      };
    }

    await timeButton.click();

    // Click the Next button to advance to the booking form
    await page.getByRole("button", { name: /^Next/i }).waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: /^Next/i }).click();

    // Wait for the booking form to load
    await page.waitForLoadState("domcontentloaded");

    // Fill name and email
    await page.getByLabel(/name/i).first().fill(name);
    await page.getByLabel(/email/i).first().fill(email);

    if (phone) await page.getByLabel(/phone/i).first().fill(phone);

    // Submit the form
    const submitButton = page
      .getByRole("button", { name: /schedule event|confirm|submit/i })
      .first();
    await submitButton.click({ timeout: 10000 });

    // If Calendly shows a reCAPTCHA challenge, wait for the checkbox and click it
    const recaptchaFrame = page.frameLocator('iframe[title="reCAPTCHA"]');
    const checkbox = recaptchaFrame.locator("#recaptcha-anchor");
    try {
      await checkbox.waitFor({ state: "visible", timeout: 8000 });
      await checkbox.click();
      // Wait for the checkmark animation to complete, then click the modal's Continue button
      await recaptchaFrame.locator(".recaptcha-checkbox-checked").waitFor({ state: "visible", timeout: 10000 });
      await page.getByRole("button", { name: /continue/i }).click({ timeout: 5000 });
    } catch {
      // No CAPTCHA appeared — proceed normally
    }

    await page.waitForSelector('h1:has-text("You are scheduled")', { timeout: 30000 });

    return { message: `Appointment booked for ${date} at ${time}.` };
  } finally {
    await browser.close();
  }
}
