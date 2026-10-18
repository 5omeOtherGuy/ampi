/**
 * Core-owned "chrome owner" seam.
 *
 * ampi-core draws a two-line footer in locked modes (`status.ts`). An
 * extension that draws its own terminal chrome (for example `ampi-tui`)
 * registers here, and while any owner is registered core leaves Pi's footer
 * slot alone: it neither installs its footer nor restores Pi's. Mode state,
 * `/ampi-status`, and every other core surface keep working unchanged.
 *
 * Disabling the owning extension makes the footer come back, because the
 * owner is registered at runtime rather than by changing core.
 *
 * globalThis-anchored so registrations survive Pi's cache-isolated module
 * loads (each extension entrypoint may get its own copy of this module).
 */

interface MmrChromeOwnerToken {
  readonly name: string;
}

const AMPI_CHROME_OWNERS_GLOBAL_KEY = "__pi_ampi_chrome_owners_v1__";
const globalStore = globalThis as typeof globalThis & {
  [AMPI_CHROME_OWNERS_GLOBAL_KEY]?: MmrChromeOwnerToken[];
};

function getOwners(): MmrChromeOwnerToken[] {
  let owners = globalStore[AMPI_CHROME_OWNERS_GLOBAL_KEY];
  if (!owners) {
    owners = [];
    globalStore[AMPI_CHROME_OWNERS_GLOBAL_KEY] = owners;
  }
  return owners;
}

/**
 * Register `name` as the owner of ampi's terminal chrome. The most recent
 * registration wins. Returns an idempotent function that removes exactly
 * this registration.
 */
export function registerMmrChromeOwner(name: string): () => void {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw new Error("registerMmrChromeOwner requires a non-empty name");
  const token: MmrChromeOwnerToken = { name: trimmed };
  getOwners().push(token);
  return () => {
    const owners = getOwners();
    const index = owners.indexOf(token);
    if (index !== -1) owners.splice(index, 1);
  };
}

/** The name of the current chrome owner, or `undefined` when core owns the footer. */
export function getMmrChromeOwner(): string | undefined {
  const owners = getOwners();
  return owners.length > 0 ? owners[owners.length - 1]?.name : undefined;
}

export const registerAmpiChromeOwner = registerMmrChromeOwner;
export const getAmpiChromeOwner = getMmrChromeOwner;
