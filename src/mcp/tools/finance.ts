import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { InvalidStateError, NotFoundError, isoDay } from "../../erp/store.js";
import { CURRENCY, type Invoice } from "../../erp/types.js";
import { cents, dateString, json } from "../helpers.js";
import type { ToolContext } from "../context.js";
import { runWrite } from "../writes.js";
import { confirmShape, DESTRUCTIVE, READ, WRITE } from "./shared.js";

const DAY = 86_400_000;
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY));

const invoiceRow = (i: Invoice, today: string) => ({
  id: i.id,
  customer_id: i.customerId,
  amount: cents(i.amountCents),
  currency: CURRENCY,
  issued_on: i.issuedOn,
  due_on: i.dueOn,
  status: i.status,
  paid_on: i.paidOn ?? null,
  days_overdue: i.status === "open" ? Math.max(0, daysBetween(i.dueOn, today)) : 0,
});

export function registerFinanceTools(server: McpServer, ctx: ToolContext): void {
  const today = () => isoDay(ctx.now());

  server.registerTool(
    "invoices_list",
    {
      title: "List invoices",
      description: "Invoices filtered by status, customer and due-date range, sorted by due date.",
      inputSchema: {
        status: z.enum(["open", "paid", "void"]).optional(),
        customer_id: z.string().regex(/^C-\d{3}$/).optional(),
        due_from: dateString.optional(),
        due_to: dateString.optional(),
        limit: z.number().int().min(1).max(100).default(25),
      },
      annotations: READ,
    },
    ({ status, customer_id, due_from, due_to, limit }) => {
      const all = ctx.store.listInvoices({ status, customerId: customer_id, from: due_from, to: due_to });
      return json({ total_matching: all.length, shown: Math.min(all.length, limit), invoices: all.slice(0, limit).map((i) => invoiceRow(i, today())) });
    },
  );

  server.registerTool(
    "receivables_summary",
    {
      title: "Receivables aging",
      description: "Open invoices grouped by how overdue they are: not yet due, 1-30, 31-60 and 61+ days.",
      inputSchema: { as_of: dateString.optional().describe("Defaults to today.") },
      annotations: READ,
    },
    ({ as_of }) => {
      const day = as_of ?? today();
      const buckets = { not_due: [0, 0], overdue_1_30: [0, 0], overdue_31_60: [0, 0], overdue_61_plus: [0, 0] } as Record<string, [number, number]>;
      for (const i of ctx.store.listInvoices({ status: "open" })) {
        const late = daysBetween(i.dueOn, day);
        const key = late <= 0 ? "not_due" : late <= 30 ? "overdue_1_30" : late <= 60 ? "overdue_31_60" : "overdue_61_plus";
        const b = buckets[key] as [number, number];
        b[0] += 1;
        b[1] += i.amountCents;
      }
      const out = Object.fromEntries(Object.entries(buckets).map(([k, [n, c]]) => [k, { invoices: n, amount: cents(c) }]));
      const total = Object.values(buckets).reduce((s, [, c]) => s + c, 0);
      return json({ as_of: day, currency: CURRENCY, total_open: cents(total), ...out });
    },
  );

  server.registerTool(
    "payables_list",
    { title: "List payables", description: "Bills to pay, sorted by due date.", inputSchema: { status: z.enum(["open", "paid"]).optional() }, annotations: READ },
    ({ status }) =>
      json({
        payables: ctx.store.listPayables({ status }).map((p) => ({ id: p.id, supplier: p.supplier, description: p.description, amount: cents(p.amountCents), currency: CURRENCY, due_on: p.dueOn, status: p.status })),
      }),
  );

  server.registerTool(
    "cashflow_forecast",
    {
      title: "Cash flow forecast",
      description: "Expected money in (open invoices) and out (open payables) in weekly buckets from today. Amounts already overdue are reported separately, not guessed into a week.",
      inputSchema: { days: z.number().int().min(7).max(90).default(28) },
      annotations: READ,
    },
    ({ days }) => {
      const start = today();
      const weeks = Math.ceil(days / 7);
      const rows = Array.from({ length: weeks }, (_, w) => ({ from: addDays(start, w * 7), to: addDays(start, w * 7 + 6), money_in: 0, money_out: 0 }));
      let overdueIn = 0;
      let overdueOut = 0;
      for (const i of ctx.store.listInvoices({ status: "open" })) {
        const off = daysBetween(start, i.dueOn);
        if (off < 0) overdueIn += i.amountCents;
        else if (off < weeks * 7) (rows[Math.floor(off / 7)] as { money_in: number }).money_in += i.amountCents;
      }
      for (const p of ctx.store.listPayables({ status: "open" })) {
        const off = daysBetween(start, p.dueOn);
        if (off < 0) overdueOut += p.amountCents;
        else if (off < weeks * 7) (rows[Math.floor(off / 7)] as { money_out: number }).money_out += p.amountCents;
      }
      return json({
        currency: CURRENCY,
        weeks: rows.map((r) => ({ ...r, money_in: cents(r.money_in), money_out: cents(r.money_out), net: cents(r.money_in - r.money_out) })),
        already_overdue: { receivable: cents(overdueIn), payable: cents(overdueOut) },
      });
    },
  );
}

export function registerFinanceWriteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "invoice_mark_paid",
    {
      title: "Mark an invoice as paid",
      description: "Records a payment against an open invoice. Two steps: PREVIEW first, then confirm=true with the token.",
      inputSchema: { invoice_id: z.string().regex(/^INV-\d{4}$/), paid_on: dateString, method: z.enum(["card", "transfer", "cash"]), ...confirmShape },
      annotations: WRITE,
    },
    ({ confirm, confirmation_token, ...args }) =>
      runWrite(ctx, {
        tool: "invoice_mark_paid",
        family: "finance-write",
        args,
        confirm,
        confirmationToken: confirmation_token,
        plan: () => {
          const inv = ctx.store.getInvoice(args.invoice_id);
          if (!inv) throw new NotFoundError(`invoice ${args.invoice_id} not found`);
          if (inv.status !== "open") throw new InvalidStateError(`invoice ${inv.id} is ${inv.status}, only open invoices can be marked as paid`);
          if (args.paid_on > isoDay(ctx.now())) throw new InvalidStateError("paid_on cannot be in the future");
          if (args.paid_on < inv.issuedOn) throw new InvalidStateError(`paid_on cannot be before the issue date (${inv.issuedOn})`);
          return {
            summary: `Mark invoice ${inv.id} (${CURRENCY} ${cents(inv.amountCents).toFixed(2)}, customer ${inv.customerId}) as paid on ${args.paid_on} by ${args.method}.`,
            auditDetail: { invoice_id: inv.id, amount: cents(inv.amountCents) },
            run: () => json({ updated: invoiceRow(ctx.store.markInvoicePaid(inv.id, args.paid_on, args.method), isoDay(ctx.now())) }),
          };
        },
      }),
  );

  server.registerTool(
    "payable_create",
    {
      title: "Create a payable",
      description: "Registers a bill to pay. Two steps: PREVIEW first, then confirm=true with the token.",
      inputSchema: {
        supplier: z.string().min(2).max(80),
        description: z.string().min(2).max(200),
        amount: z.number().positive().max(1_000_000).describe("In currency units, e.g. 249.90"),
        due_date: dateString,
        ...confirmShape,
      },
      annotations: WRITE,
    },
    ({ confirm, confirmation_token, ...args }) =>
      runWrite(ctx, {
        tool: "payable_create",
        family: "finance-write",
        args,
        confirm,
        confirmationToken: confirmation_token,
        plan: () => {
          const amountCents = Math.round(args.amount * 100);
          return {
            summary: `Create a payable of ${CURRENCY} ${(amountCents / 100).toFixed(2)} to "${args.supplier}" (${args.description}), due ${args.due_date}.`,
            auditDetail: { amount: amountCents / 100, due_date: args.due_date },
            run: () => json({ created: ctx.store.createPayable({ supplier: args.supplier, description: args.description, amountCents, dueOn: args.due_date }) }),
          };
        },
      }),
  );
}

export function registerFinanceDeleteTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "payable_delete",
    {
      title: "Delete a payable",
      description: "Permanently deletes an OPEN payable. Cannot be undone. Two steps: PREVIEW first, then confirm=true with the token.",
      inputSchema: { payable_id: z.string().regex(/^BILL-\d+$/), ...confirmShape },
      annotations: DESTRUCTIVE,
    },
    ({ confirm, confirmation_token, ...args }) =>
      runWrite(ctx, {
        tool: "payable_delete",
        family: "finance-delete",
        args,
        confirm,
        confirmationToken: confirmation_token,
        plan: () => {
          const p = ctx.store.getPayable(args.payable_id);
          if (!p) throw new NotFoundError(`payable ${args.payable_id} not found`);
          if (p.status !== "open") throw new InvalidStateError(`payable ${p.id} is already paid and cannot be deleted`);
          return {
            summary: `PERMANENTLY delete payable ${p.id}: ${CURRENCY} ${cents(p.amountCents).toFixed(2)} to "${p.supplier}", due ${p.dueOn}. This cannot be undone.`,
            auditDetail: { payable_id: p.id, amount: cents(p.amountCents) },
            run: () => {
              ctx.store.deletePayable(p.id);
              return json({ deleted: p.id });
            },
          };
        },
      }),
  );
}
