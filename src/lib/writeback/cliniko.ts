import type { WritebackInput, WritebackTarget } from "./types";

/**
 * Cliniko write-back.
 *
 * UNVERIFIED AGAINST THE LIVE API. The request payload below follows Cliniko's published
 * conventions as I understand them (basic auth with the API key as username, a regional shard in
 * the key suffix, a required User-Agent), but the treatment-note schema, especially how a template's
 * sections are filled, has not been checked against https://docs.api.cliniko.com or a real account.
 * Check `buildPayload` before using this with real patient data.
 *
 * Safety choices that do not depend on the schema:
 * - notes are created as drafts in Cliniko so the physio finalises them there
 * - no automatic retries: the service decides what a retry means, so a timeout cannot create duplicates
 * - error text never echoes the response body, which could contain patient data
 */

export interface ClinikoOptions {
  apiKey?: string;
  userAgent?: string;
  /** Cliniko treatment note template to fill. Required by Cliniko for template-based notes. */
  templateId?: string;
  fetchImpl?: typeof fetch;
}

const SHARD = /^[a-z]{2}\d$/;

export function shardFromKey(apiKey: string): string | null {
  const shard = apiKey.split("-").pop() ?? "";
  return SHARD.test(shard) ? shard : null;
}

export function buildPayload(input: WritebackInput, templateId?: string) {
  return {
    patient_id: input.patientId,
    ...(templateId ? { treatment_note_template_id: templateId } : {}),
    title: input.title,
    draft: true,
    content: {
      sections: [
        {
          name: "Consultation note",
          questions: [{ name: "Note", type: "Text", answer: input.text }],
        },
      ],
    },
  };
}

export class ClinikoTarget implements WritebackTarget {
  readonly name = "cliniko";
  readonly label = "Cliniko";
  private opts: ClinikoOptions;

  constructor(opts: ClinikoOptions) {
    this.opts = opts;
  }

  isConfigured(): boolean {
    return Boolean(this.opts.apiKey && shardFromKey(this.opts.apiKey) && this.opts.userAgent);
  }

  async createNote(input: WritebackInput): Promise<{ externalId: string }> {
    const { apiKey, userAgent } = this.opts;
    if (!apiKey || !userAgent) throw new Error("Cliniko is not configured");
    const shard = shardFromKey(apiKey);
    if (!shard) throw new Error("The Cliniko API key does not end in a region such as -uk1");
    if (!/^\d{1,20}$/.test(input.patientId)) throw new Error("The Cliniko patient ID should be a number");

    const f = this.opts.fetchImpl ?? fetch;
    const res = await f(`https://api.${shard}.cliniko.com/v1/treatment_notes`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
        "User-Agent": userAgent,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildPayload(input, this.opts.templateId)),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) throw new Error(`Cliniko responded with status ${res.status}`);
    const json = (await res.json().catch(() => null)) as { id?: number | string } | null;
    if (!json || json.id === undefined) throw new Error("Cliniko accepted the request but returned no note id");
    return { externalId: String(json.id) };
  }
}
