import { z } from 'zod';

/*
 * Response schemas of the Kalorické tabulky JSON API. They are deliberately lenient about optional
 * fields (KT adds and drops them freely) but strict about the parts consumers rely on: the envelope,
 * `code`, the `data` shape and the types of timestamps and values. Unknown keys are kept (`passthrough`).
 */

/** Numbers sometimes arrive as strings (`"97,5"`); `null` means "no value". */
export const ktNumberishSchema = z.union([z.number(), z.string()]).nullish();

const envelope = <T extends z.ZodTypeAny>(data: T) =>
  z
    .object({
      requestId: z.unknown().optional(),
      code: z.number(),
      message: z.string().nullish(),
      data,
    })
    .passthrough();

/** Only `code` matters for detecting a failed (logged-out) call; `data` is validated per endpoint. */
export const ktEnvelopeSchema = envelope(z.unknown());

/* ---------- /statistic/optional: `data` is an array of series ---------- */

export const ktSeriesValueSchema = z
  .object({
    guid: z.string().nullish(),
    /** Epoch ms of local midnight in Europe/Prague. */
    from: z.number(),
    to: z.number().nullish(),
    value: ktNumberishSchema,
    valueString: z.string().nullish(),
  })
  .passthrough();
export type KtSeriesValue = z.infer<typeof ktSeriesValueSchema>;

/** KT sometimes wraps a point as `{ value: point, target }`. */
export const ktWrappedSeriesValueSchema = z.object({ value: ktSeriesValueSchema, target: z.unknown().optional() }).passthrough();

/**
 * Checks every entry on its own (flat point or wrapped point), drops malformed ones, flattens and
 * dedupes by `guid` (by `from` when there is no guid). A single odd entry never fails the response.
 */
export function flattenKtSeriesValues(entries: readonly unknown[]): KtSeriesValue[] {
  const seen = new Set<string>();
  const out: KtSeriesValue[] = [];
  for (const entry of entries) {
    const flat = ktSeriesValueSchema.safeParse(entry);
    const point = flat.success ? flat.data : ktWrappedSeriesValueSchema.safeParse(entry).data?.value;
    if (point === undefined) continue;
    const key = point.guid != null ? `g:${point.guid}` : `f:${point.from}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(point);
  }
  return out;
}

export const ktSeriesSchema = z
  .object({
    guid: z.string().nullish(),
    /** Human label, e.g. `Obvod břicha [cm]`, `Tuky [%]`. */
    type: z.string(),
    from: z.number().nullish(),
    to: z.number().nullish(),
    unit: z.string().nullish(),
    graph: z.boolean().nullish(),
    nutrientsTarget: z.array(z.unknown()).nullish(),
    nutrientsValues: z.array(z.unknown()).nullish(),
    nutrientsTableData: z.array(z.unknown()).nullish(),
    target: z.unknown().optional(),
    /** Raw and lossless (the app archives it as KT sent it); consumers call `flattenKtSeriesValues`. */
    values: z.array(z.unknown()).nullish(),
  })
  .passthrough();
export type KtSeries = z.infer<typeof ktSeriesSchema>;

export const ktOptionalStatsResponseSchema = envelope(z.array(ktSeriesSchema).nullish());
export type KtOptionalStatsResponse = z.infer<typeof ktOptionalStatsResponseSchema>;

/* ---------- /statistic/energy and /statistic/nutrients: `data` is one object ---------- */

/** `{ from, value, description?, status? }` – one day of energy (or a target). */
export const ktDayValueSchema = z
  .object({
    from: z.number().nullish(),
    value: ktNumberishSchema,
    description: z.string().nullish(),
    status: z.number().nullish(),
  })
  .passthrough();
export type KtDayValue = z.infer<typeof ktDayValueSchema>;

/** `{ from: null, value, status }` – one macro of a nutrients entry; `value` is grams. */
export const ktMacroCellSchema = z.object({ from: z.number().nullish(), value: ktNumberishSchema, status: z.number().nullish() }).passthrough();
export type KtMacroCell = z.infer<typeof ktMacroCellSchema>;

/**
 * Days and table rows stay `unknown[]` here: a single odd entry must not fail the whole response.
 * Use `ktDayValueSchema`, `ktNutrientsEntrySchema` and `ktNutrientsTableRowSchema` per entry.
 */
export const ktStatisticObjectSchema = z
  .object({
    type: z.string(),
    unit: z.string().nullish(),
    values: z.array(z.unknown()).nullish(),
    target: z.unknown().optional(),
    tableData: z.array(z.unknown()).nullish(),
    nutrientsValues: z.array(z.unknown()).nullish(),
    nutrientsTableData: z.array(z.unknown()).nullish(),
  })
  .passthrough();
export type KtStatisticObject = z.infer<typeof ktStatisticObjectSchema>;

/** `nutrientsValues[i]` – the day is `createdDate`, NOT the nested `from` (which is null). */
export const ktNutrientsEntrySchema = z
  .object({
    createdDate: z.number().nullish(),
    protein: ktMacroCellSchema.nullish(),
    fat: ktMacroCellSchema.nullish(),
    carbs: ktMacroCellSchema.nullish(),
    fiber: ktMacroCellSchema.nullish(),
  })
  .passthrough();
export type KtNutrientsEntry = z.infer<typeof ktNutrientsEntrySchema>;

/** `nutrientsTableData[i]` – the day sits on `*Target.from`. */
export const ktNutrientsTableRowSchema = z
  .object({
    proteinTarget: ktMacroCellSchema.nullish(),
    fatTarget: ktMacroCellSchema.nullish(),
    carbsTarget: ktMacroCellSchema.nullish(),
    proteinValue: ktMacroCellSchema.nullish(),
    fatValue: ktMacroCellSchema.nullish(),
    carbsValue: ktMacroCellSchema.nullish(),
    fiberValue: ktMacroCellSchema.nullish(),
  })
  .passthrough();
export type KtNutrientsTableRow = z.infer<typeof ktNutrientsTableRowSchema>;

export const ktEnergyResponseSchema = envelope(ktStatisticObjectSchema.nullish());
export type KtEnergyResponse = z.infer<typeof ktEnergyResponseSchema>;

export const ktNutrientsResponseSchema = envelope(ktStatisticObjectSchema.nullish());
export type KtNutrientsResponse = z.infer<typeof ktNutrientsResponseSchema>;

/* ---------- /statistic/weight: points in `data.target` (object) or `data` itself (array) ---------- */

/** KT does not truncate at `limit`; `page`, `limit` and `targetPaged` are ignored. Entries stay raw. */
const ktWeightObjectSchema = z
  .object({
    type: z.literal('weight'),
    target: z.array(z.unknown()).nullish(),
    min: ktNumberishSchema,
    max: ktNumberishSchema,
  })
  .passthrough();

export const ktWeightResponseSchema = envelope(z.union([ktWeightObjectSchema, z.array(z.unknown())]).nullish());
export type KtWeightResponse = z.infer<typeof ktWeightResponseSchema>;

/** The weight points of either shape; malformed entries are dropped. */
export function ktWeightPoints(data: KtWeightResponse['data']): KtSeriesValue[] {
  const entries = Array.isArray(data) ? data : (data?.target ?? []);
  const points: KtSeriesValue[] = [];
  for (const entry of entries) {
    const parsed = ktSeriesValueSchema.safeParse(entry);
    if (parsed.success) points.push(parsed.data);
  }
  return points;
}

/* ---------- /statistic/summary/{date} and /user/weight/add ---------- */

export const ktWeightSummaryResponseSchema = envelope(
  z
    .object({
      monthWeight: z.array(z.object({ description: z.string(), value: z.number() }).passthrough()),
    })
    .passthrough(),
);
export type KtWeightSummaryResponse = z.infer<typeof ktWeightSummaryResponseSchema>;

export const ktLoginResponseSchema = ktEnvelopeSchema;
