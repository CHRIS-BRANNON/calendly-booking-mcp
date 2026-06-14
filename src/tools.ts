import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listAvailableSlots, bookAppointment } from "./calendly.js";
import type { JWTPayload } from "./auth.js";
import { version } from "../package.json";

const bookingDescription =
  process.env.BOOKING_DESCRIPTION ?? "Books appointments on a public Calendly page.";

export function createServer(user: JWTPayload): McpServer {
  const server = new McpServer({
    name: "calendly-booking-mcp",
    version,
    description:
      bookingDescription +
      " Always call list_available_slots first to find open dates and times before booking." +
      " When booking, only the date, time, and phone number are needed — name and email come from the authenticated user.",
  });

  server.registerTool(
    "list_available_slots",
    {
      description:
        "Returns available appointment slots on the Calendly booking page. " +
        "Omit 'date' to get all available dates for the current month. " +
        "Pass a date in YYYY-MM-DD format to get time slots for that specific day.",
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
          .refine(
            (d) => new Date(d) >= new Date(new Date().toDateString()),
            "Date must not be in the past",
          )
          .optional()
          .describe("Specific date in YYYY-MM-DD format. Omit to list available dates."),
      },
    },
    async ({ date }) => {
      try {
        const slots = await listAvailableSlots(date);
        return {
          content: [{ type: "text", text: JSON.stringify(slots, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "book_appointment",
    {
      description:
        "Books an appointment on the Calendly page. " +
        "Name and email are taken automatically from the authenticated user's Google account. " +
        "Call list_available_slots first to get valid dates and times.",
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
          .refine(
            (d) => new Date(d) >= new Date(new Date().toDateString()),
            "Date must not be in the past",
          )
          .describe("Date in YYYY-MM-DD format"),
        time: z
          .string()
          .describe(
            "Time slot to book, exactly as returned by list_available_slots, e.g. '9:00am'",
          ),
        phone: z
          .string()
          .regex(/^\+1\d{10}$/, "Phone number must be in +1XXXXXXXXXX format")
          .optional()
          .describe("US phone number in +1XXXXXXXXXX format, e.g. +12125551234. Optional."),
      },
    },
    async ({ date, time, phone }) => {
      try {
        const result = await bookAppointment(date, time, user.name, user.email, phone ?? "");
        return {
          content: [{ type: "text", text: result.message }],
        };
      } catch (err) {
        return {
          content: [
            { type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}
