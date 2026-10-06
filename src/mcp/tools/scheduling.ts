import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InvalidStateError, NotFoundError } from "../../erp/store.js";
import { SERVICES, STAFF } from "../../erp/types.js";
import { dateString, fail, isoDateTime, json } from "../helpers.js";
import type { ToolContext } from "../context.js";
import { runWrite } from "../writes.js";
import { confirmShape, READ, WRITE } from "./shared.js";

const staff = z.enum(STAFF);

export function registerSchedulingTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "appointments_list",
    {
      title: "List appointments",
      description: "Appointments in a date range (at most 62 days), sorted by start time.",
      inputSchema: { from: dateString, to: dateString, staff: staff.optional(), status: z.enum(["booked", "completed", "cancelled", "no_show"]).optional() },
      annotations: READ,
    },
    ({ from, to, staff: s, status }) => {
      if (to < from) return fail("`to` must not be before `from`");
      if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 62) return fail("range too long: ask for 62 days or fewer");
      const rows = ctx.store.listAppointments({ from, to, staff: s, status });
      return json({
        count: rows.length,
        appointments: rows.map((a) => ({ id: a.id, start: a.start, end: a.end, staff: a.staff, service: a.service, status: a.status, customer_id: a.customerId, customer: ctx.store.getCustomer(a.customerId)?.name })),
      });
    },
  );

  server.registerTool(
    "appointments_availability",
    {
      title: "Free appointment slots",
      description: "Free start times for one staff member on one day, on a 30-minute grid inside working hours (09:00-17:00 UTC).",
      inputSchema: { date: dateString, staff, duration_minutes: z.number().int().min(15).max(120).default(30) },
      annotations: READ,
    },
    ({ date, staff: s, duration_minutes }) => json({ date, staff: s, duration_minutes, free_slots: ctx.store.freeSlots(date, s, duration_minutes) }),
  );
}

export function registerSchedulingWriteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "appointment_book",
    {
      title: "Book an appointment",
      description: "Books an appointment. Two steps: the first call returns a PREVIEW, the second (confirm=true plus the token) books it.",
      inputSchema: {
        customer_id: z.string().regex(/^C-\d{3}$/),
        staff,
        service: z.enum(SERVICES),
        start: isoDateTime,
        duration_minutes: z.number().int().min(15).max(120).default(30),
        ...confirmShape,
      },
      annotations: WRITE,
    },
    ({ confirm, confirmation_token, ...args }) =>
      runWrite(ctx, {
        tool: "appointment_book",
        family: "scheduling-write",
        args,
        confirm,
        confirmationToken: confirmation_token,
        plan: () => {
          const customer = ctx.store.getCustomer(args.customer_id);
          if (!customer) throw new NotFoundError(`customer ${args.customer_id} not found`);
          ctx.store.assertSlotFree(args.staff, args.start, args.duration_minutes);
          return {
            summary: `Book a ${args.service} for ${customer.name} (${customer.id}) with ${args.staff} on ${args.start}, ${args.duration_minutes} minutes.`,
            auditDetail: { customer_id: args.customer_id, staff: args.staff, start: args.start },
            run: () => json({ booked: ctx.store.bookAppointment({ customerId: args.customer_id, staff: args.staff, service: args.service, start: args.start, durationMinutes: args.duration_minutes }) }),
          };
        },
      }),
  );

  server.registerTool(
    "appointment_cancel",
    {
      title: "Cancel an appointment",
      description: "Cancels a booked appointment. Two steps: PREVIEW first, then confirm=true with the token.",
      inputSchema: { appointment_id: z.string().regex(/^A-\d{4}$/), reason: z.string().min(3).max(200), ...confirmShape },
      annotations: WRITE,
    },
    ({ confirm, confirmation_token, ...args }) =>
      runWrite(ctx, {
        tool: "appointment_cancel",
        family: "scheduling-write",
        args,
        confirm,
        confirmationToken: confirmation_token,
        plan: () => {
          const a = ctx.store.getAppointment(args.appointment_id);
          if (!a) return failPlan(`appointment ${args.appointment_id} not found`);
          if (a.status !== "booked") return failPlan(`appointment ${a.id} is ${a.status}, only booked ones can be cancelled`);
          return {
            summary: `Cancel appointment ${a.id} (${a.service} with ${a.staff} on ${a.start}). Reason: ${args.reason}.`,
            auditDetail: { appointment_id: a.id },
            run: () => json({ cancelled: ctx.store.cancelAppointment(a.id, args.reason) }),
          };
        },
      }),
  );
}

function failPlan(message: string): never {
  throw new InvalidStateError(message);
}
