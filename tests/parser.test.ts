import { it } from "@effect/vitest"
import { Effect } from "effect"
import { describe, expect } from "vitest"
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

      const symbolNames = parsed.symbols.map((s) => s.name)
      expect(symbolNames).toContain("Loggable")
      expect(symbolNames).toContain("UserService")
      expect(symbolNames).toContain("UserService.log")
      expect(symbolNames).toContain("UserService.getUser")
      expect(symbolNames).toContain("defaultService")
      expect(symbolNames).toContain("UserId")

      // Check contains edges
      const containsEdges = parsed.edges.filter((e) => e.kind === "contains")
      expect(
        containsEdges.some((e) => e.srcName === "UserService" && e.dstName === "UserService.log")
      ).toBe(true)
      expect(
        containsEdges.some(
          (e) => e.srcName === "UserService" && e.dstName === "UserService.getUser"
        )
      ).toBe(true)

      // Check extends edge
      const extendsEdges = parsed.edges.filter((e) => e.kind === "extends")
      expect(
        extendsEdges.some((e) => e.srcName === "UserService" && e.dstName === "BaseService")
      ).toBe(true)

      // Check implements edge
      const implementsEdges = parsed.edges.filter((e) => e.kind === "implements")
      expect(
        implementsEdges.some((e) => e.srcName === "UserService" && e.dstName === "Loggable")
      ).toBe(true)

      // Check call edge (this.log() resolves to the enclosing class method)
      const callEdges = parsed.edges.filter((e) => e.kind === "call")
      expect(
        callEdges.some(
          (e) => e.srcName === "UserService.getUser" && e.dstName === "UserService.log"
        )
      ).toBe(true)
    }).pipe(Effect.provide(ParserLive))
  )

  it.effect("attributes calls in object-literal callbacks to the containing symbol", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse(
        "src/config.ts",
        `
function helper() {
  return 42;
}

export const config = createConfig({
  onReady: () => helper()
});
`
      )

      const callEdges = parsed.edges.filter((e) => e.kind === "call")
      expect(callEdges.some((e) => e.srcName === "config" && e.dstName === "helper")).toBe(true)
    }).pipe(Effect.provide(ParserLive))
  )

  it.effect("extracts typed arrow components with docs and full signatures", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse(
        "src/UIFundsCompare.tsx",
        `
/** Compares a list of funds. */
export const UIFundsCompare: ({ fund_codes }: { fund_codes: string[] }) => JSX.Element = ({
  fund_codes,
}) => <div>{fund_codes.join(",")}</div>
`
      )

      const symbol = parsed.symbols.find((s) => s.name === "UIFundsCompare")
      expect(symbol?.kind).toBe("function")
      expect(symbol?.doc).toContain("Compares a list of funds")
      expect(symbol?.signature).toContain("fund_codes")
      expect(symbol?.signature).toContain("JSX.Element")
    }).pipe(Effect.provide(ParserLive))
  )

  it.effect("keeps full signatures for multiline object parameter types", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse(
        "src/fund-returns.ts",
        `
/** Get fund sizes data */
export function useFundSizes(
  params: {
    fundType: FundType;
    startDate?: string;
    endDate?: string;
    page?: number;
  },
  options?: { enabled?: boolean },
) {
  return params;
}
`
      )

      const symbol = parsed.symbols.find((s) => s.name === "useFundSizes")
      expect(symbol?.doc).toContain("Get fund sizes data")
      expect(symbol?.signature).toContain("startDate?: string")
      expect(symbol?.signature).toContain("options?: { enabled?: boolean }")
      expect(symbol?.signature).toContain("export function useFundSizes")
    }).pipe(Effect.provide(ParserLive))
  )

  it.effect("keeps JSDoc tags such as @throws in documentation", () =>
    Effect.gen(function* () {
      const parser = yield* Parser
      const parsed = yield* parser.parse(
        "src/use-tefas-client.ts",
        `
/**
 * Hook to access the TEFAS client instance
 * @throws Error if client is not initialized
 */
export function useTefasClient(): TefasClient {
  throw new Error("not initialized");
}
`
      )

      const symbol = parsed.symbols.find((s) => s.name === "useTefasClient")
      expect(symbol?.doc).toContain("Hook to access the TEFAS client instance")
      expect(symbol?.doc).toContain("@throws Error if client is not initialized")
      expect(symbol?.signature).toBe("export function useTefasClient(): TefasClient")
    }).pipe(Effect.provide(ParserLive))
  )
})
