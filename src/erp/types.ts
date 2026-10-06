export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  documentId: string;
  city: string;
  lastVisit?: string; // YYYY-MM-DD
}

export type AppointmentStatus = "booked" | "completed" | "cancelled" | "no_show";

export interface Appointment {
  id: string;
  customerId: string;
  staff: string;
  service: string;
  start: string; // ISO 8601 UTC
  end: string;
  status: AppointmentStatus;
  cancelReason?: string;
}

export type InvoiceStatus = "open" | "paid" | "void";

export interface Invoice {
  id: string;
  customerId: string;
  amountCents: number;
  issuedOn: string; // YYYY-MM-DD
  dueOn: string;
  status: InvoiceStatus;
  paidOn?: string;
  method?: string;
}

export interface Payable {
  id: string;
  supplier: string;
  description: string;
  amountCents: number;
  dueOn: string;
  status: "open" | "paid";
}

export const CURRENCY = "USD";
export const STAFF = ["dr-ada", "dr-ben", "hyg-cam"] as const;
export const SERVICES = ["check-up", "cleaning", "consultation", "follow-up"] as const;
