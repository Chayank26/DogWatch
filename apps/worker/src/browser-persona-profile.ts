/** Fixed synthetic profiles; never authorization grants. */
import { z } from 'zod';
export const personaSchema = z.enum([
  'novice',
  'keyboard_only',
  'impatient',
  'unusual_input',
]);
export type BrowserPersona = z.infer<typeof personaSchema>;
export const personaInstructions: Record<BrowserPersona, string> = {
  novice:
    'Use visible labels and a straightforward journey. Do not assume hidden controls or application expertise.',
  keyboard_only:
    'Use keyboard interaction only. Never substitute pointer interaction or claim accessibility compliance.',
  impatient:
    'Prefer a short journey. Do not repeat submissions or bypass permission checks to save time.',
  unusual_input:
    'Explore only the supplied synthetic boundary-value references. Never invent raw input or credentials.',
};
