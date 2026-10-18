// The ampi app page's client helpers (ampi-gui/client/app-mode.js): where a
// session's requests go, page addresses and history entries, the sidebar's
// status icon labels, the banner for each state the hub answers, escaping,
// and the session list's refresh timer. The modules load in Node without a
// DOM; the page wiring is checked in a browser.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { cleanupLoadedSource, importSource } from "./helpers/load-src.mjs";

after(cleanupLoadedSource);

const appMode = () => importSource("extensions/ampi-gui/client/app-mode.js");

const ID = "01a150bc-ea6f-7062-a933-90fbda7c6e1a";

describe("ampi app page: session base and addresses", () => {
  it("sends a session server's requests to /api/ and the app's to /s/<id>/api/", async () => {
    const { sessionBase } = await appMode();
    assert.equal(sessionBase(false, ID), "/api/", "a session server runs one session, whatever is shown");
    assert.equal(sessionBase(false, null), "/api/");
    assert.equal(sessionBase(true, ID), `/s/${ID}/api/`);
    assert.equal(sessionBase(true, null), "/api/", "the home page shows no session");
    assert.equal(sessionBase(true, "a b"), "/s/a%20b/api/");
  });

  it("parses the page's own addresses and nothing else", async () => {
    const { parseAppPath, appPath } = await appMode();
    assert.deepEqual(parseAppPath("/"), { id: null });
    assert.deepEqual(parseAppPath(`/s/${ID}`), { id: ID });
    assert.deepEqual(parseAppPath(`/s/${ID}/`), { id: ID });
    assert.deepEqual(parseAppPath("/s/abc_DEF-9"), { id: "abc_DEF-9" });
    for (const pathname of ["", "/s", "/s/", `/s/${ID}/api/transcript`, "/s/%2e%2e", "/s/%E0%A4%A", "/s/a%2Fb", "/client/app.js", `/x/${ID}`, `/s/${"a".repeat(129)}`]) {
      assert.equal(parseAppPath(pathname), null, pathname);
    }
    assert.equal(appPath(null), "/");
    assert.equal(appPath(ID), `/s/${ID}`);
    assert.deepEqual(parseAppPath(appPath(ID)), { id: ID });
  });

  it("restores the session of a history entry, else the one its address names", async () => {
    const { historyState, routeFromHistory } = await appMode();
    assert.deepEqual(historyState(ID), { ampiSession: ID });
    assert.deepEqual(historyState(null), { ampiSession: null });
    assert.deepEqual(historyState(undefined), { ampiSession: null });
    assert.equal(routeFromHistory({ ampiSession: ID }, "/"), ID, "the entry wins over the address");
    assert.equal(routeFromHistory({ ampiSession: null }, `/s/${ID}`), null, "an entry of the home page");
    assert.equal(routeFromHistory(null, `/s/${ID}`), ID, "an entry the page did not write");
    assert.equal(routeFromHistory({ other: 1 }, "/"), null);
    assert.equal(routeFromHistory({ ampiSession: "../x" }, `/s/${ID}`), ID, "a stored id the server would refuse is ignored");
  });
});

describe("ampi app page: sidebar status icons", () => {
  const host = (kind, gui, phase) => ({ kind, pid: 4242, gui, phase });

  it("names the host and then every flag, for every combination", async () => {
    const { statusIconLabel } = await appMode();
    assert.equal(statusIconLabel(null), "Not running");
    assert.equal(statusIconLabel(undefined), "Not running");
    const expected = [
      [host("tui", false, null), "Running in a terminal"],
      [host("tui", false, "idle"), "Running in a terminal"],
      [host("tui", false, "thinking"), "Running in a terminal, Working"],
      [host("tui", false, "error"), "Running in a terminal, Error"],
      [host("tui", true, null), "Running in a terminal, Live"],
      [host("tui", true, "idle"), "Running in a terminal, Live"],
      [host("tui", true, "runningTools"), "Running in a terminal, Live, Working"],
      [host("tui", true, "error"), "Running in a terminal, Live, Error"],
      [host("execute", false, null), "Running in ampi -x"],
      [host("execute", false, "idle"), "Running in ampi -x"],
      [host("execute", false, "streaming"), "Running in ampi -x, Working"],
      [host("execute", false, "error"), "Running in ampi -x, Error"],
      [host("execute", true, "waitingApproval"), "Running in ampi -x, Live, Working"],
      [host("app-session", true, null), "Running in ampi app, Live"],
      [host("app-session", true, "idle"), "Running in ampi app, Live"],
      [host("app-session", true, "compacting"), "Running in ampi app, Live, Working"],
      [host("app-session", true, "error"), "Running in ampi app, Live, Error"],
      [host("app-session", false, "sending"), "Running in ampi app, Working"],
    ];
    for (const [value, label] of expected) assert.equal(statusIconLabel(value), label, JSON.stringify(value));
  });

  it("spins only while the process that has the session open works on it", async () => {
    const { hostWorking } = await appMode();
    assert.equal(hostWorking(null), false);
    assert.equal(hostWorking(host("tui", false, null)), false, "an entry without a status");
    assert.equal(hostWorking(host("tui", false, "idle")), false);
    assert.equal(hostWorking(host("tui", false, "error")), false, "a failed turn has ended");
    for (const phase of ["sending", "thinking", "streaming", "runningTools", "compacting", "waitingApproval", "cancelling"]) {
      assert.equal(hostWorking(host("tui", false, phase)), true, phase);
    }
  });
});

describe("ampi app page: banners", () => {
  it("chooses read-only with the holder and its pid for a session another process has open", async () => {
    const { bannerFor } = await appMode();
    const banner = (kind) => bannerFor({ state: "elsewhere", kind, pid: 4242, error: "ignored" }, "Fix the build");
    assert.deepEqual(banner("tui"), {
      access: "held",
      html: "<strong>Fix the build</strong> is open in a terminal (pid 4242). Continue it there; here it is read-only, so the two never write the same file.",
    });
    assert.match(banner("execute").html, /is open in an ampi -x run \(pid 4242\)\./);
    assert.match(banner("app-session").html, /is open in another ampi app \(pid 4242\)\./);
    assert.match(banner("later-kind").html, /is open in process 4242 \(later-kind\)\./);
  });

  it("tells how to continue here when the holding terminal runs without the web GUI", async () => {
    const { bannerFor } = await appMode();
    const banner = (state) => bannerFor({ state: "elsewhere", pid: 4242, error: "ignored", ...state }, "Fix the build");
    assert.deepEqual(banner({ kind: "tui", gui: false }), {
      access: "held",
      html: "<strong>Fix the build</strong> is open in a terminal (pid 4242), which does not run the web GUI. To continue it here, turn on ampiGui in that terminal; until then it is read-only here.",
    });
    // A terminal whose GUI the hub could not reach, an unknown GUI and other holders keep the plain banner.
    for (const state of [{ kind: "tui", gui: true }, { kind: "tui" }, { kind: "execute", gui: false }]) {
      assert.match(banner(state).html, /Continue it there; here it is read-only/, JSON.stringify(state));
    }
  });

  it("keeps the composer for a session nothing runs, turns it off with a reason for an imported one, and says when the worker stopped", async () => {
    const { bannerFor } = await appMode();
    assert.deepEqual(bannerFor({ state: "not-running", error: "ignored" }, "T"), { access: "dormant" });
    assert.deepEqual(bannerFor({ state: "imported", error: "ignored" }, "T"), {
      access: "imported",
      reason: "This session was imported, so it can be read here but not continued.",
    });
    const gone = { access: "gone", html: "The process that ran <strong>T</strong> here has stopped. Pick the session again to continue it." };
    assert.deepEqual(bannerFor({ state: "gone", error: "ignored" }, "T"), gone);
    assert.deepEqual(bannerFor(undefined, "T"), gone, "a failed request without a body");
    assert.match(bannerFor({ state: "elsewhere", kind: "tui", pid: 1 }, "").html, /^<strong>This session<\/strong> is open/, "an untitled session");
  });

  it("escapes titles and holder names", async () => {
    const { bannerFor, escapeHtml } = await appMode();
    assert.equal(escapeHtml(`<img src=x onerror="a('b')"> & co`), "&#60;img src=x onerror=&#34;a(&#39;b&#39;)&#34;&#62; &#38; co");
    const held = bannerFor({ state: "elsewhere", kind: "<script>x</script>", pid: 7 }, "<b>Tom & Jerry's</b>");
    assert.equal(
      held.html,
      "<strong>&#60;b&#62;Tom &#38; Jerry&#39;s&#60;/b&#62;</strong> is open in process 7 (&#60;script&#62;x&#60;/script&#62;). Continue it there; here it is read-only, so the two never write the same file.",
    );
    assert.match(bannerFor({ state: "gone" }, "<i>").html, /<strong>&#60;i&#62;<\/strong>/);
  });
});

describe("ampi app page: refreshing the session list", () => {
  function harness() {
    const timers = new Set();
    const state = { visible: true, runs: 0 };
    return {
      state,
      timers,
      options: {
        run: () => state.runs++,
        everyMs: 5_000,
        visible: () => state.visible,
        setTimer: (callback, ms) => {
          const timer = { callback, ms };
          timers.add(timer);
          return timer;
        },
        clearTimer: (timer) => timers.delete(timer),
      },
      /** Run the pending timers once, as if their time had come. */
      elapse() {
        for (const timer of [...timers]) {
          timers.delete(timer);
          timer.callback();
        }
      },
    };
  }

  it("reloads every 5 seconds while the page is visible, stops while hidden and reloads at once when shown again", async () => {
    const { createRefresher, APP_LIST_REFRESH_MS } = await appMode();
    assert.equal(APP_LIST_REFRESH_MS, 5_000);
    const h = harness();
    const refresher = createRefresher(h.options);
    refresher.start();
    assert.equal(h.state.runs, 0, "start only schedules");
    assert.deepEqual([...h.timers].map((timer) => timer.ms), [5_000]);
    h.elapse();
    h.elapse();
    assert.equal(h.state.runs, 2);
    assert.equal(h.timers.size, 1, "one timer at a time");

    h.state.visible = false;
    refresher.visibilityChanged();
    assert.equal(h.timers.size, 0, "a hidden page keeps no timer");
    refresher.visibilityChanged();
    assert.equal(h.state.runs, 2);

    h.state.visible = true;
    refresher.visibilityChanged();
    assert.equal(h.state.runs, 3, "shown again, it reloads at once");
    assert.equal(h.timers.size, 1);
    refresher.visibilityChanged();
    assert.equal(h.state.runs, 3, "a second visible notice does not reload twice");
    assert.equal(h.timers.size, 1);
  });

  it("skips a tick that fires after the page was hidden without a notice", async () => {
    const { createRefresher } = await appMode();
    const h = harness();
    createRefresher(h.options).start();
    h.state.visible = false;
    h.elapse();
    assert.equal(h.state.runs, 0);
    assert.equal(h.timers.size, 0);
  });
});
