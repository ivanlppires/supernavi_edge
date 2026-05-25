import { z } from 'zod';

export const clinicalContextSchema = z.object({
  exam_type: z.enum(['AP', 'CITO']),
  subtipo: z.string().min(1).max(120),
  sexo: z.enum(['F', 'M', 'outro']),
  idade: z.number().int().min(0).max(130),
  material: z.string().min(1).max(500),
  hipotese: z.string().max(500).optional().nullable(),
});

export const confirmBodySchema = z.object({
  filename: z.string().regex(
    /^(AP|PA|IM|C)\d{6,12}[A-Z]?\d*$/,
    'filename must match AP/PA/IM/C + 6-12 digits + optional letter/digits'
  ),
  clinicalContext: clinicalContextSchema.optional(),
});
