import { createHash } from 'node:crypto';
import { devices } from 'playwright';
import { z } from 'zod';
import { JevwrightError } from './errors.ts';

const viewport = z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict();
export const deviceSchema = z.union([z.enum(['desktop', 'mobile']), z.object({ viewport, isMobile: z.boolean().optional(), hasTouch: z.boolean().optional(), userAgent: z.string().min(1).optional() }).strict()]);
export type Device = z.infer<typeof deviceSchema>;
export function resolveDevice(device?: Device, fallback = { width: 1280, height: 900 }) {
    if (device !== undefined && !deviceSchema.safeParse(device).success) { throw new JevwrightError('Invalid device; use desktop, mobile, or a viewport device object'); }
    if (device === 'mobile') { return { key: 'mobile', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: devices['Pixel 7']!.userAgent }; }
    if (!device || device === 'desktop') { return { key: 'desktop', viewport: fallback, isMobile: false, hasTouch: false, deviceScaleFactor: 1 }; }
    const settings = { viewport: { width: device.viewport.width, height: device.viewport.height }, isMobile: device.isMobile ?? false, hasTouch: device.hasTouch ?? false, deviceScaleFactor: 1, ...(device.userAgent ? { userAgent: device.userAgent } : {}) };
    return { key: `custom-${createHash('sha1').update(JSON.stringify(settings)).digest('hex').slice(0, 12)}`, ...settings };
}
export type ResolvedDevice = ReturnType<typeof resolveDevice>;
