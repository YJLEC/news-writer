import type { BrowserWindow, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: class {},
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  session: {
    defaultSession: {
      setPermissionCheckHandler: vi.fn(),
      setPermissionRequestHandler: vi.fn(),
    },
  },
}));

import { isTrustedSender, trustedProductionUrl } from './window.js';

const senderFixture = (url = trustedProductionUrl, destroyed = false) =>
  ({
    sender: { getURL: () => url, isDestroyed: () => destroyed } as WebContents,
    frame: { url, parent: null },
  }) as const;

const windowFixture = (sender: WebContents, destroyed = false) =>
  ({ isDestroyed: () => destroyed, webContents: sender }) as BrowserWindow;

describe('isTrustedSender', () => {
  it('accepts only the live top frame of the production main window', () => {
    const fixture = senderFixture();
    expect(isTrustedSender(fixture.sender, fixture.frame, windowFixture(fixture.sender))).toBe(
      true,
    );
    expect(
      isTrustedSender(
        fixture.sender,
        { ...fixture.frame, parent: {} },
        windowFixture(fixture.sender),
      ),
    ).toBe(false);
    expect(
      isTrustedSender(fixture.sender, fixture.frame, windowFixture(fixture.sender), undefined),
    ).toBe(true);
  });

  it('rejects destroyed senders, destroyed windows, and non-main web contents', () => {
    const live = senderFixture();
    const destroyed = senderFixture(trustedProductionUrl, true);
    expect(
      isTrustedSender(destroyed.sender, destroyed.frame, windowFixture(destroyed.sender)),
    ).toBe(false);
    expect(isTrustedSender(live.sender, live.frame, windowFixture(live.sender, true))).toBe(false);
    expect(isTrustedSender(live.sender, live.frame, windowFixture(senderFixture().sender))).toBe(
      false,
    );
  });

  it('rejects wrong production URLs and non-exact development origins', () => {
    const wrongProduction = senderFixture('app://untrusted/index.html');
    expect(
      isTrustedSender(
        wrongProduction.sender,
        wrongProduction.frame,
        windowFixture(wrongProduction.sender),
      ),
    ).toBe(false);

    const developmentUrl = 'http://127.0.0.1:5173/';
    const development = senderFixture(developmentUrl);
    expect(
      isTrustedSender(
        development.sender,
        development.frame,
        windowFixture(development.sender),
        developmentUrl,
      ),
    ).toBe(true);
    const wrongOrigin = senderFixture('http://localhost:5173/');
    expect(
      isTrustedSender(
        wrongOrigin.sender,
        wrongOrigin.frame,
        windowFixture(wrongOrigin.sender),
        developmentUrl,
      ),
    ).toBe(false);
  });
});
