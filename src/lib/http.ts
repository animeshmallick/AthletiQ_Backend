import type { Response } from 'express';

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** Success envelope: `{ data, meta? }`. Errors use `{ error: { code, message, details, requestId } }`. */
export function ok<T>(res: Response, data: T, meta?: object) {
  return res.status(200).json(meta ? { data, meta } : { data });
}

export function created<T>(res: Response, data: T) {
  return res.status(201).json({ data });
}

export function noContent(res: Response) {
  return res.status(204).end();
}

export function pageMeta(page: number, pageSize: number, total: number): PageMeta {
  return { page, pageSize, total, totalPages: Math.max(1, Math.ceil(total / pageSize)) };
}
