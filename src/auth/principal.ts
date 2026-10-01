import { SCOPE_CONFIDENTIAL, SCOPE_READ } from "./config.js";

/** The dashboard user behind an MCP session, as mcp_lookup_user returns them. */
export type DashboardUser = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  practiceGroup: string | null;
};

/**
 * The authenticated caller of an MCP request.
 *
 * `kind` records how identity was established, because the two are not
 * equivalent and the audit log has to say which: a `user` principal is a named
 * person who signed in with their @amana.id Google account, whereas a `service`
 * principal is whoever holds the shared static token.
 */
export type Principal =
  | {
      kind: "user";
      user: DashboardUser;
      clientId: string;
      clientName: string | null;
      scopes: string[];
    }
  | {
      kind: "service";
      label: string;
      scopes: string[];
    };

/**
 * Scopes a user's session may hold, derived from their dashboard role.
 *
 * This is the rule that keeps an external AI tool from outreaching the person
 * driving it: confidential deliverables are readable through MCP only by roles
 * that can already read them in the dashboard.
 */
export function scopesForUser(user: DashboardUser, confidentialRoles: string[]): string[] {
  const scopes = [SCOPE_READ];
  if (confidentialRoles.includes(user.role.toLowerCase())) {
    scopes.push(SCOPE_CONFIDENTIAL);
  }
  return scopes;
}

export function principalEmail(principal: Principal): string | null {
  return principal.kind === "user" ? principal.user.email : null;
}

export function principalUserId(principal: Principal): string | null {
  return principal.kind === "user" ? principal.user.id : null;
}

export function principalRole(principal: Principal): string {
  return principal.kind === "user" ? principal.user.role : "service";
}

export function principalPracticeGroup(principal: Principal): string | null {
  return principal.kind === "user" ? principal.user.practiceGroup : null;
}

export function principalClientId(principal: Principal): string {
  return principal.kind === "user" ? principal.clientId : principal.label;
}

export function principalClientName(principal: Principal): string | null {
  return principal.kind === "user" ? principal.clientName : principal.label;
}

export function principalLabel(principal: Principal): string {
  return principal.kind === "user" ? principal.user.email : `service:${principal.label}`;
}

export function mayReadConfidential(principal: Principal): boolean {
  return principal.scopes.includes(SCOPE_CONFIDENTIAL);
}
