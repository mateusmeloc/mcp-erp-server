// Roles decide which tool FAMILIES are registered for a caller.
//
// The role does not filter what is displayed: it decides what exists. A tool that was never
// registered for a caller cannot be called by mistake, nor by a model that was talked into it.

/** A family is the smallest unit a role can grant. */
export type Family =
  | "system" //          erp_status
  | "customers" //       customer_search, customer_get (personal data masked)
  | "customers-pii" //   customer_get_contact (full contact details, audited)
  | "scheduling" //      appointments_list, appointments_availability
  | "scheduling-write" // appointment_book, appointment_cancel
  | "finance" //         invoices_list, receivables_summary, cashflow_forecast, payables_list
  | "finance-write" //   invoice_mark_paid, payable_create
  | "finance-delete"; // payable_delete — kept apart on purpose

export type Role =
  /** Owners. Everything, including families added in the future. */
  | "admin"
  /** Runs the day to day, including money, but cannot delete financial records. */
  | "manager"
  /** Front desk: customers (masked) and the calendar. No money. */
  | "frontdesk"
  /** An automated agent that talks to strangers (e.g. a chat bot). Calendar only. */
  | "agent";

export const ROLES: readonly Role[] = ["admin", "manager", "frontdesk", "agent"];

/**
 * `admin` is not listed on purpose: it gets every family, even one added tomorrow. The other
 * roles are closed lists, so a new family is invisible to them until someone adds it deliberately.
 */
const GRANTS: Record<Exclude<Role, "admin">, readonly Family[]> = {
  manager: ["system", "customers", "customers-pii", "scheduling", "scheduling-write", "finance", "finance-write"],
  frontdesk: ["system", "customers", "scheduling", "scheduling-write"],
  agent: ["scheduling", "scheduling-write"],
};

export function roleAllows(role: Role, family: Family): boolean {
  return role === "admin" || GRANTS[role].includes(family);
}

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}
