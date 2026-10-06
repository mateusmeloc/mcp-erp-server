// An in-memory mock ERP. Everything here is synthetic: replace this module with a client for your
// real system and keep the tool layer as is.

import {
  type Appointment,
  type Customer,
  type Invoice,
  type InvoiceStatus,
  type Payable,
  SERVICES,
  STAFF,
} from "./types.js";

const DAY_MS = 86_400_000;
export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 17;

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY_MS);

/** Small deterministic PRNG so the seed data (and the tests) never change between runs. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PEOPLE: Array<[string, string]> = [
  ["Alex Rivera", "Springfield"],
  ["Jordan Lee", "Riverton"],
  ["Sam Okafor", "Springfield"],
  ["Taylor Brooks", "Lakeside"],
  ["Morgan Silva", "Riverton"],
  ["Casey Novak", "Lakeside"],
  ["Riley Chen", "Springfield"],
  ["Avery Hughes", "Hillcrest"],
  ["Quinn Patel", "Hillcrest"],
  ["Jamie Costa", "Riverton"],
  ["Drew Fischer", "Lakeside"],
  ["Robin Alvarez", "Springfield"],
];

const SUPPLIERS = ["Example Supplies Ltd", "Sample Utilities Co", "Demo Lab Services", "Placeholder Rent LLC", "Acme Cleaning"];

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
export class InvalidStateError extends Error {}

export interface Store {
  searchCustomers(query: string, limit: number): Customer[];
  getCustomer(id: string): Customer | undefined;
  listAppointments(f: { from: string; to: string; staff?: string; status?: string }): Appointment[];
  freeSlots(date: string, staff: string, durationMinutes: number): string[];
  bookAppointment(a: { customerId: string; staff: string; service: string; start: string; durationMinutes: number }): Appointment;
  assertSlotFree(staff: string, start: string, durationMinutes: number): void;
  getAppointment(id: string): Appointment | undefined;
  cancelAppointment(id: string, reason: string): Appointment;
  listInvoices(f: { status?: InvoiceStatus; customerId?: string; from?: string; to?: string }): Invoice[];
  getInvoice(id: string): Invoice | undefined;
  markInvoicePaid(id: string, paidOn: string, method: string): Invoice;
  listPayables(f: { status?: "open" | "paid" }): Payable[];
  getPayable(id: string): Payable | undefined;
  createPayable(p: Omit<Payable, "id" | "status">): Payable;
  deletePayable(id: string): void;
}

export function createStore(now: () => Date = () => new Date()): Store {
  const rand = mulberry32(20260101);
  const today = new Date(`${isoDay(now())}T00:00:00Z`);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)] as T;
  const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

  const customers: Customer[] = PEOPLE.map(([name, city], i) => {
    const n = String(i + 1).padStart(3, "0");
    const slug = name.toLowerCase().replace(/\s+/g, ".");
    return {
      id: `C-${n}`,
      name,
      city,
      email: `${slug}@example.test`,
      phone: `+1-555-01${String(10 + i)}`,
      documentId: `DOC-${100000 + i * 7919}`,
      lastVisit: isoDay(addDays(today, -between(3, 120))),
    };
  });

  const appointments: Appointment[] = [];
  const overlaps = (staff: string, start: Date, end: Date, ignoreId?: string) =>
    appointments.some(
      (a) => a.id !== ignoreId && a.staff === staff && a.status === "booked" && new Date(a.start) < end && new Date(a.end) > start,
    );

  let apptSeq = 0;
  for (let i = 0; i < 40 && appointments.length < 26; i++) {
    const day = addDays(today, between(-10, 10));
    const start = new Date(day.getTime() + between(WORK_START_HOUR, WORK_END_HOUR - 1) * 3_600_000);
    const end = new Date(start.getTime() + 30 * 60_000);
    const staff = pick(STAFF);
    const past = start < today;
    if (!past && overlaps(staff, start, end)) continue;
    const roll = rand();
    appointments.push({
      id: `A-${String(++apptSeq).padStart(4, "0")}`,
      customerId: pick(customers).id,
      staff,
      service: pick(SERVICES),
      start: start.toISOString(),
      end: end.toISOString(),
      status: past ? (roll < 0.1 ? "no_show" : "completed") : "booked",
    });
  }

  const invoices: Invoice[] = Array.from({ length: 30 }, (_, i) => {
    const issued = addDays(today, -between(1, 90));
    const due = addDays(issued, 30);
    const roll = rand();
    const base: Invoice = {
      id: `INV-${String(1001 + i)}`,
      customerId: pick(customers).id,
      amountCents: between(80, 2500) * 100 + pick([0, 50, 95]),
      issuedOn: isoDay(issued),
      dueOn: isoDay(due),
      status: "open",
    };
    if (roll < 0.05) return { ...base, status: "void" as const };
    if (roll < 0.55) return { ...base, status: "paid" as const, paidOn: isoDay(addDays(issued, between(0, 30))), method: pick(["card", "transfer", "cash"]) };
    return base;
  });

  const payables: Payable[] = Array.from({ length: 10 }, (_, i) => ({
    id: `BILL-${String(501 + i)}`,
    supplier: pick(SUPPLIERS),
    description: pick(["Monthly supplies", "Utilities", "Equipment service", "Rent", "Cleaning"]),
    amountCents: between(150, 4000) * 100,
    dueOn: isoDay(addDays(today, between(-20, 40))),
    status: rand() < 0.35 ? ("paid" as const) : ("open" as const),
  }));

  let billSeq = 501 + payables.length;
  const find = <T extends { id: string }>(xs: T[], id: string, label: string): T => {
    const x = xs.find((e) => e.id === id);
    if (!x) throw new NotFoundError(`${label} ${id} not found`);
    return x;
  };

  const store: Store = {
    searchCustomers(query, limit) {
      const q = query.trim().toLowerCase();
      return customers.filter((c) => !q || c.name.toLowerCase().includes(q) || c.id.toLowerCase() === q || c.city.toLowerCase().includes(q)).slice(0, limit);
    },
    getCustomer: (id) => customers.find((c) => c.id === id),

    listAppointments({ from, to, staff, status }) {
      return appointments
        .filter((a) => a.start.slice(0, 10) >= from && a.start.slice(0, 10) <= to && (!staff || a.staff === staff) && (!status || a.status === status))
        .sort((a, b) => a.start.localeCompare(b.start));
    },
    freeSlots(date, staff, durationMinutes) {
      const slots: string[] = [];
      const open = new Date(`${date}T00:00:00Z`).getTime() + WORK_START_HOUR * 3_600_000;
      const close = new Date(`${date}T00:00:00Z`).getTime() + WORK_END_HOUR * 3_600_000;
      for (let t = open; t + durationMinutes * 60_000 <= close; t += 30 * 60_000) {
        if (!overlaps(staff, new Date(t), new Date(t + durationMinutes * 60_000))) slots.push(new Date(t).toISOString());
      }
      return slots;
    },
    assertSlotFree(staff, start, durationMinutes) {
      const s = new Date(start);
      const e = new Date(s.getTime() + durationMinutes * 60_000);
      const h = s.getUTCHours() + s.getUTCMinutes() / 60;
      const hEnd = h + durationMinutes / 60;
      if (h < WORK_START_HOUR || hEnd > WORK_END_HOUR) throw new InvalidStateError(`outside working hours (${WORK_START_HOUR}:00-${WORK_END_HOUR}:00 UTC)`);
      if (s < now()) throw new InvalidStateError("cannot book in the past");
      if (overlaps(staff, s, e)) throw new ConflictError(`${staff} is already booked at ${start}`);
    },
    bookAppointment({ customerId, staff, service, start, durationMinutes }) {
      find(customers, customerId, "customer");
      store.assertSlotFree(staff, start, durationMinutes);
      const s = new Date(start);
      const a: Appointment = {
        id: `A-${String(++apptSeq).padStart(4, "0")}`,
        customerId,
        staff,
        service,
        start: s.toISOString(),
        end: new Date(s.getTime() + durationMinutes * 60_000).toISOString(),
        status: "booked",
      };
      appointments.push(a);
      return a;
    },
    getAppointment: (id) => appointments.find((a) => a.id === id),
    cancelAppointment(id, reason) {
      const a = find(appointments, id, "appointment");
      if (a.status !== "booked") throw new InvalidStateError(`appointment ${id} is ${a.status}, only booked ones can be cancelled`);
      a.status = "cancelled";
      a.cancelReason = reason;
      return a;
    },

    listInvoices({ status, customerId, from, to }) {
      return invoices
        .filter((i) => (!status || i.status === status) && (!customerId || i.customerId === customerId) && (!from || i.dueOn >= from) && (!to || i.dueOn <= to))
        .sort((a, b) => a.dueOn.localeCompare(b.dueOn));
    },
    getInvoice: (id) => invoices.find((i) => i.id === id),
    markInvoicePaid(id, paidOn, method) {
      const inv = find(invoices, id, "invoice");
      if (inv.status !== "open") throw new InvalidStateError(`invoice ${id} is ${inv.status}, only open invoices can be marked as paid`);
      inv.status = "paid";
      inv.paidOn = paidOn;
      inv.method = method;
      return inv;
    },

    listPayables: ({ status }) => payables.filter((p) => !status || p.status === status).sort((a, b) => a.dueOn.localeCompare(b.dueOn)),
    getPayable: (id) => payables.find((p) => p.id === id),
    createPayable(p) {
      const bill: Payable = { id: `BILL-${billSeq++}`, ...p, status: "open" };
      payables.push(bill);
      return bill;
    },
    deletePayable(id) {
      const p = find(payables, id, "payable");
      if (p.status !== "open") throw new InvalidStateError(`payable ${id} is already paid and cannot be deleted`);
      payables.splice(payables.indexOf(p), 1);
    },
  };
  return store;
}
