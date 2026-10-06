// Data minimization for personal records. Tools return the smallest useful view by default;
// full contact details live behind a separate, audited tool that only some roles can reach.

import type { Customer } from "./types.js";

export function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 1)}***@${domain}`;
}

export function maskPhone(phone: string): string {
  return `***-${phone.replace(/\D/g, "").slice(-4)}`;
}

export function maskDocument(doc: string): string {
  return `***${doc.slice(-3)}`;
}

/** What a search result is allowed to say about a person: who they are, not how to reach them. */
export function customerSummary(c: Customer) {
  return { id: c.id, name: c.name, city: c.city, last_visit: c.lastVisit ?? null };
}

/** A profile with contact details masked. */
export function customerMasked(c: Customer) {
  return { ...customerSummary(c), email: maskEmail(c.email), phone: maskPhone(c.phone), document_id: maskDocument(c.documentId) };
}

/** Full contact details. Only the audited contact tool may call this. */
export function customerContact(c: Customer) {
  return { id: c.id, name: c.name, email: c.email, phone: c.phone, document_id: c.documentId };
}
