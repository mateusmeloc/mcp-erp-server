import test from "node:test";
import assert from "node:assert/strict";
import { ADMIN, AGENT, FRONTDESK, MANAGER, connectAs, makeClock, makeDeps, testConfig } from "./helpers.js";

const TOKEN = /confirmation_token="([^"]+)"/;
const tokenFrom = (text: string) => (TOKEN.exec(text) ?? [])[1] as string;

const ALL = [
  "appointment_book", "appointment_cancel", "appointments_availability", "appointments_list", "cashflow_forecast",
  "customer_get", "customer_get_contact", "customer_search", "erp_status", "invoice_mark_paid", "invoices_list",
  "payable_create", "payable_delete", "payables_list", "receivables_summary",
];

test("each role is registered only the tools it can reach", async () => {
  const { deps } = makeDeps();
  assert.deepEqual(await (await connectAs(deps, ADMIN)).tools(), ALL);
  assert.deepEqual(await (await connectAs(deps, MANAGER)).tools(), ALL.filter((t) => t !== "payable_delete"));
  assert.deepEqual(
    await (await connectAs(deps, FRONTDESK)).tools(),
    ["appointment_book", "appointment_cancel", "appointments_availability", "appointments_list", "customer_get", "customer_search", "erp_status"],
  );
  assert.deepEqual(await (await connectAs(deps, AGENT)).tools(), ["appointment_book", "appointment_cancel", "appointments_availability", "appointments_list"]);
});

test("a tool outside the role does not exist: calling it fails", async () => {
  const { deps } = makeDeps();
  const agent = await connectAs(deps, AGENT);
  const a = await agent.call("invoices_list");
  assert.equal(a.isError, true);
  assert.match(a.text, /not found/i);
  const b = await agent.call("customer_get_contact", { customer_id: "C-001", reason: "just curious" });
  assert.equal(b.isError, true);
  assert.match(b.text, /not found/i);
});

test("erp_status reports who you are", async () => {
  const { deps } = makeDeps();
  const r = (await (await connectAs(deps, MANAGER)).call("erp_status")).json();
  assert.equal(r.user, "mia");
  assert.equal(r.role, "manager");
});

test("customers: search and profile never expose raw contact details", async () => {
  const { deps } = makeDeps();
  const fred = await connectAs(deps, FRONTDESK);
  const search = await fred.call("customer_search", { query: "springfield" });
  assert.ok(search.json().count > 0);
  assert.doesNotMatch(search.text, /@|555|DOC-/);

  const profile = await fred.call("customer_get", { customer_id: "C-001" });
  assert.match(profile.json().email, /^\w\*\*\*@example\.test$/);
  assert.match(profile.json().phone, /^\*\*\*-\d{4}$/);
  assert.doesNotMatch(profile.text, /alex\.rivera|DOC-1/);
  assert.equal((await fred.call("customer_get", { customer_id: "C-999" })).isError, true);
});

test("full contact details: only for roles that have the family, and always audited", async () => {
  const { deps, events } = makeDeps();
  const mia = await connectAs(deps, MANAGER);
  const r = await mia.call("customer_get_contact", { customer_id: "C-001", reason: "confirming an appointment by phone" });
  assert.match(r.json().email, /@example\.test$/);
  const ev = events.find((e) => e.event === "sensitive-read");
  assert.ok(ev);
  assert.equal(ev.user, "mia");
  assert.equal(ev.customer_id, "C-001");
  const denied = await (await connectAs(deps, FRONTDESK)).call("customer_get_contact", { customer_id: "C-001", reason: "no access here" });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /not found/i);
});

test("scheduling: availability, then a two-step booking with a matching token", async () => {
  const { deps, events } = makeDeps();
  const mia = await connectAs(deps, MANAGER);
  const free = (await mia.call("appointments_availability", { date: "2026-03-03", staff: "dr-ada", duration_minutes: 30 })).json().free_slots as string[];
  assert.ok(free.length > 0);
  const start = free[0] as string;
  const args = { customer_id: "C-002", staff: "dr-ada", service: "check-up", start, duration_minutes: 30 };

  const preview = await mia.call("appointment_book", args);
  assert.match(preview.text, /^PREVIEW — nothing has been changed/);
  assert.equal((await mia.call("appointments_list", { from: "2026-03-03", to: "2026-03-03", staff: "dr-ada" })).json().appointments.some((a: any) => a.start === start), false);
  const token = tokenFrom(preview.text);

  const noToken = await mia.call("appointment_book", { ...args, confirm: true });
  assert.equal(noToken.isError, true);
  const changed = await mia.call("appointment_book", { ...args, duration_minutes: 60, confirm: true, confirmation_token: token });
  assert.equal(changed.isError, true, "different arguments than the preview");
  assert.match(changed.text, /differ/);

  const done = await mia.call("appointment_book", { ...args, confirm: true, confirmation_token: token });
  assert.equal(done.isError, false);
  assert.equal(done.json().booked.status, "booked");

  assert.equal((await mia.call("appointment_book", { ...args, confirm: true, confirmation_token: token })).isError, true, "token is single use");
  assert.equal((await mia.call("appointment_book", args)).isError, true, "the slot is taken now");
  assert.equal(((await mia.call("appointments_availability", { date: "2026-03-03", staff: "dr-ada" })).json().free_slots as string[]).includes(start), false);

  assert.deepEqual(events.filter((e) => e.tool === "appointment_book").map((e) => e.event), ["preview", "denied", "denied", "executed", "denied", "denied"]);
});

test("scheduling: refuses the past and times outside working hours", async () => {
  const { deps } = makeDeps();
  const bot = await connectAs(deps, AGENT);
  const base = { customer_id: "C-001", staff: "dr-ben", service: "cleaning", duration_minutes: 30 };
  assert.match((await bot.call("appointment_book", { ...base, start: "2026-03-01T10:00:00Z" })).text, /past/);
  assert.match((await bot.call("appointment_book", { ...base, start: "2026-03-03T20:00:00Z" })).text, /working hours/);
  assert.match((await bot.call("appointment_book", { ...base, customer_id: "C-404", start: "2026-03-03T10:00:00Z" })).text, /not found/);
});

test("scheduling: cancel flow and its guards", async () => {
  const { deps } = makeDeps();
  const mia = await connectAs(deps, MANAGER);
  const booked = (await mia.call("appointments_list", { from: "2026-03-02", to: "2026-03-20", status: "booked" })).json().appointments as Array<{ id: string }>;
  assert.ok(booked.length > 0);
  const id = (booked[0] as { id: string }).id;
  const preview = await mia.call("appointment_cancel", { appointment_id: id, reason: "patient asked to cancel" });
  assert.match(preview.text, /PREVIEW/);
  const done = await mia.call("appointment_cancel", { appointment_id: id, reason: "patient asked to cancel", confirm: true, confirmation_token: tokenFrom(preview.text) });
  assert.equal(done.json().cancelled.status, "cancelled");
  assert.match((await mia.call("appointment_cancel", { appointment_id: id, reason: "again please" })).text, /only booked/);
});

test("read-range guards on the calendar", async () => {
  const { deps } = makeDeps();
  const fred = await connectAs(deps, FRONTDESK);
  assert.equal((await fred.call("appointments_list", { from: "2026-03-10", to: "2026-03-01" })).isError, true);
  assert.match((await fred.call("appointments_list", { from: "2026-01-01", to: "2026-12-31" })).text, /62 days/);
  const badDate = await fred.call("appointments_list", { from: "2026-02-31", to: "2026-03-01" });
  assert.equal(badDate.isError, true);
  assert.match(badDate.text, /not a real date/);
});

test("finance: receivables aging adds up to the open invoices", async () => {
  const { deps } = makeDeps();
  const mia = await connectAs(deps, MANAGER);
  const s = (await mia.call("receivables_summary")).json();
  const open = deps.store.listInvoices({ status: "open" });
  const expected = open.reduce((n, i) => n + i.amountCents, 0) / 100;
  assert.equal(s.total_open, expected);
  assert.equal(s.not_due.invoices + s.overdue_1_30.invoices + s.overdue_31_60.invoices + s.overdue_61_plus.invoices, open.length);
  assert.equal(s.not_due.amount + s.overdue_1_30.amount + s.overdue_31_60.amount + s.overdue_61_plus.amount > 0, true);
});

test("finance: cash flow buckets are consistent", async () => {
  const { deps } = makeDeps();
  const f = (await (await connectAs(deps, MANAGER)).call("cashflow_forecast", { days: 28 })).json();
  assert.equal(f.weeks.length, 4);
  for (const w of f.weeks) assert.equal(Math.round((w.money_in - w.money_out) * 100), Math.round(w.net * 100));
  const open = deps.store.listInvoices({ status: "open" }).reduce((n, i) => n + i.amountCents, 0) / 100;
  const inWindow = f.weeks.reduce((n: number, w: any) => n + w.money_in, 0) + f.already_overdue.receivable;
  assert.ok(inWindow <= open + 0.001);
});

test("finance: mark an invoice as paid, with its guards", async () => {
  const { deps, events } = makeDeps();
  const mia = await connectAs(deps, MANAGER);
  const invoice = deps.store.listInvoices({ status: "open" })[0];
  assert.ok(invoice);
  const args = { invoice_id: invoice.id, paid_on: "2026-03-02", method: "transfer" };

  assert.match((await mia.call("invoice_mark_paid", { ...args, paid_on: "2026-03-09" })).text, /future/);
  assert.match((await mia.call("invoice_mark_paid", { ...args, paid_on: "2000-01-01" })).text, /before the issue date/);

  const preview = await mia.call("invoice_mark_paid", args);
  assert.match(preview.text, new RegExp(invoice.id));
  const done = await mia.call("invoice_mark_paid", { ...args, confirm: true, confirmation_token: tokenFrom(preview.text) });
  assert.equal(done.json().updated.status, "paid");
  assert.match((await mia.call("invoice_mark_paid", args)).text, /only open/);

  const audited = JSON.stringify(events);
  assert.match(audited, /"event":"executed"/);
  assert.doesNotMatch(audited, /@example\.test|Rivera|Okafor/, "audit never carries personal data");
});

test("finance: create a payable, then only an admin can delete it", async () => {
  const { deps } = makeDeps();
  const mia = await connectAs(deps, MANAGER);
  const args = { supplier: "Example Supplies Ltd", description: "Printer paper", amount: 249.9, due_date: "2026-03-20" };
  const preview = await mia.call("payable_create", args);
  assert.match(preview.text, /USD 249\.90/);
  const created = (await mia.call("payable_create", { ...args, confirm: true, confirmation_token: tokenFrom(preview.text) })).json().created;
  assert.equal(created.amountCents, 24990);
  assert.ok((await mia.call("payables_list", { status: "open" })).json().payables.some((p: any) => p.id === created.id));

  const noDelete = await mia.call("payable_delete", { payable_id: created.id });
  assert.equal(noDelete.isError, true, "managers cannot delete");
  assert.match(noDelete.text, /not found/i);

  const admin = await connectAs(deps, ADMIN);
  const del = await admin.call("payable_delete", { payable_id: created.id });
  assert.match(del.text, /PERMANENTLY delete/);
  assert.equal((await admin.call("payable_delete", { payable_id: created.id, confirm: true, confirmation_token: tokenFrom(del.text) })).json().deleted, created.id);
  assert.match((await admin.call("payable_delete", { payable_id: created.id })).text, /not found/);

  const paid = deps.store.listPayables({ status: "paid" })[0];
  assert.ok(paid);
  assert.match((await admin.call("payable_delete", { payable_id: paid.id })).text, /already paid/);
});

test("the global write switch blocks every write and still allows reads", async () => {
  const { deps, events } = makeDeps(testConfig({ ALLOW_WRITES: "false" }));
  const mia = await connectAs(deps, MANAGER);
  const w = await mia.call("payable_create", { supplier: "Acme Cleaning", description: "Monthly service", amount: 10, due_date: "2026-03-30" });
  assert.equal(w.isError, true);
  assert.match(w.text, /disabled/);
  assert.equal(events.at(-1)?.event, "denied");
  assert.equal((await mia.call("payables_list")).isError, false);
  assert.equal((await mia.call("erp_status")).json().writes_enabled, false);
});

test("write rate limit is per person and recovers", async () => {
  const clock = makeClock();
  const { deps } = makeDeps(testConfig({ WRITES_PER_MINUTE: "3" }), clock);
  const mia = await connectAs(deps, MANAGER);
  const root = await connectAs(deps, ADMIN);
  const args = { supplier: "Acme Cleaning", description: "Monthly service", amount: 10, due_date: "2026-03-30" };
  for (let i = 0; i < 3; i++) assert.equal((await mia.call("payable_create", args)).isError, false);
  const blocked = await mia.call("payable_create", args);
  assert.equal(blocked.isError, true);
  assert.match(blocked.text, /Rate limit/);
  assert.equal((await root.call("payable_create", args)).isError, false, "another person is not affected");
  clock.advance(61_000);
  assert.equal((await mia.call("payable_create", args)).isError, false);
});
