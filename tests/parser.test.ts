import { describe, expect } from "vitest"
import { it } from "@effect/vitest"
import { Effect } from "effect"
import { Parser, ParserLive } from "../src/services/Parser.js"

describe("Parser service", () => {
  it.effect("extracts symbols and edges from TypeScript source", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const source = `
import { BaseService } from "./base";

export interface Loggable {
  log(msg: string): void;
}

export class UserService extends BaseService implements Loggable {
  private count: number = 0;

  constructor() {
    super();
  }

  log(msg: string): void {
    console.log(msg);
  }

  getUser(id: string): string {
    this.log("fetching " + id);
    return "User: " + id;
  }
}

export const defaultService = new UserService();
export type UserId = string;
`
      const parsed = yield* parser.parse("src/user.ts", source)

      expect(parsed.path).toBe("src/user.ts")

      const symbolNames = parsed.symbols.map(s => s.name)
      expect(symbolNames).toContain("Loggable")
      expect(symbolNames).toContain("UserService")
      expect(symbolNames).toContain("UserService.log")
      expect(symbolNames).toContain("UserService.getUser")
      expect(symbolNames).toContain("defaultService")
      expect(symbolNames).toContain("UserId")

      // Check contains edges
      const containsEdges = parsed.edges.filter(e => e.kind === "contains")
      expect(containsEdges.some(e => e.srcName === "UserService" && e.dstName === "UserService.log")).toBe(true)
      expect(containsEdges.some(e => e.srcName === "UserService" && e.dstName === "UserService.getUser")).toBe(true)

      // Check extends edge
      const extendsEdges = parsed.edges.filter(e => e.kind === "extends")
      expect(extendsEdges.some(e => e.srcName === "UserService" && e.dstName === "BaseService")).toBe(true)

      // Check implements edge
      const implementsEdges = parsed.edges.filter(e => e.kind === "implements")
      expect(implementsEdges.some(e => e.srcName === "UserService" && e.dstName === "Loggable")).toBe(true)

      // Check call edge
      const callEdges = parsed.edges.filter(e => e.kind === "call")
      expect(callEdges.some(e => e.srcName === "UserService.getUser" && e.dstName === "log")).toBe(true)
    }).pipe(Effect.provide(ParserLive))
  )
})
