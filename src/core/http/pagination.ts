import { z } from 'zod';

/** `?page=&limit=` with defaults (1 / 25) and a hard cap of 100. */
export const paginationQuery = z.object({
  page: z.coerce.number().int().min(1, 'page must be ≥ 1').default(1),
  limit: z.coerce.number().int().min(1).max(100, 'limit must be ≤ 100').default(25),
});

export type Pagination = z.infer<typeof paginationQuery>;

export function skipTake({ page, limit }: Pagination) {
  return { skip: (page - 1) * limit, take: limit };
}

export function pageMeta({ page, limit }: Pagination, total: number) {
  return { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) };
}
