import type { Express, Router } from 'express';

/** A router mounted under /api/v1 (recorded by createApp). */
export interface RouteMount {
  path: string;
  router: Router;
}

export interface RoutePermission {
  keys: string[];
  any: boolean;
}

export interface RouteInfo {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** Express path, e.g. /api/v1/projects/:id/basic */
  path: string;
  /** requirePerm guards on the route (router-level ones included), in order. */
  permissions: RoutePermission[];
}

type Tagged = { permission?: RoutePermission };
interface RouteLayer {
  handle: Tagged;
  route?: { path: string | string[]; methods: Record<string, boolean>; stack: Array<{ handle: Tagged }> };
}

/**
 * Every route of the API, in mount order (the first registration of a method + path wins, as in
 * Express), with the permission guards it runs. Used by the permission parity test and the docs.
 */
export function listRoutes(app: Express): RouteInfo[] {
  const mounts = (app.locals['routeMounts'] ?? []) as RouteMount[];
  const seen = new Set<string>();
  const out: RouteInfo[] = [];
  for (const m of mounts) {
    const routerLevel: RoutePermission[] = [];
    for (const layer of (m.router as unknown as { stack: RouteLayer[] }).stack) {
      if (!layer.route) {
        if (layer.handle.permission) routerLevel.push(layer.handle.permission);
        continue;
      }
      const own = layer.route.stack.map((l) => l.handle.permission).filter((p): p is RoutePermission => Boolean(p));
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        const path = `${m.path}${p === '/' ? '' : p}` || '/';
        for (const [method, on] of Object.entries(layer.route.methods)) {
          if (!on || method === '_all') continue;
          const key = `${method} ${path}`;
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({ method: method as RouteInfo['method'], path, permissions: [...routerLevel, ...own] });
        }
      }
    }
  }
  return out;
}
