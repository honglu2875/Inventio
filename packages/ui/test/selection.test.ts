import { describe, expect, it } from "vitest";
import {
  classifyNodeId,
  permalinkFor,
  resolveNodeRoute,
  viewForNodeId,
} from "../src/lib/selection.js";

describe("classifyNodeId", () => {
  it("names every id family", () => {
    expect(classifyNodeId("problem")).toBe("problem");
    expect(classifyNodeId("memory")).toBe("memory");
    expect(classifyNodeId("final")).toBe("final");
    expect(classifyNodeId("W001")).toBe("wave");
    expect(classifyNodeId("W001:resolution")).toBe("resolution");
    expect(classifyNodeId("T001")).toBe("task");
    expect(classifyNodeId("C001")).toBe("lineage");
    expect(classifyNodeId("C001.v1")).toBe("candidate");
    expect(classifyNodeId("C001.v1:ob3")).toBe("obligation");
    expect(classifyNodeId("R001")).toBe("review");
    expect(classifyNodeId("Q001")).toBe("question");
    expect(classifyNodeId("K002")).toBe("claim");
    expect(classifyNodeId("I001")).toBe("issue");
    expect(classifyNodeId("M003")).toBe("card");
    expect(classifyNodeId("X001")).toBe("computation");
    expect(classifyNodeId("A001")).toBe("artifact");
    expect(classifyNodeId("E001")).toBe("artifact");
    expect(classifyNodeId("nope")).toBe("unknown");
  });
});

describe("viewForNodeId", () => {
  it("routes the graph families to their canvases", () => {
    expect(viewForNodeId("T001")).toBe("ops");
    expect(viewForNodeId("W001")).toBe("ops");
    expect(viewForNodeId("C001.v1")).toBe("ops");
    expect(viewForNodeId("Q001")).toBe("ops");
    expect(viewForNodeId("K002")).toBe("evidence");
    expect(viewForNodeId("I001")).toBe("evidence");
    expect(viewForNodeId("C001.v1:ob3")).toBe("evidence");
    expect(viewForNodeId("M003")).toBe("library");
    expect(viewForNodeId("A001")).toBe("library");
    expect(viewForNodeId("X001")).toBe("library");
  });
});

describe("resolveNodeRoute", () => {
  it("opens ops with ?sel= for wave/task/candidate ids", () => {
    expect(resolveNodeRoute("demo", "T001")).toEqual({
      view: "ops",
      path: "/p/demo",
      to: "/p/demo?sel=T001",
      kind: "task",
    });
    expect(resolveNodeRoute("demo", "W001").to).toBe("/p/demo?sel=W001");
    expect(resolveNodeRoute("demo", "C001.v1").to).toBe("/p/demo?sel=C001.v1");
  });

  it("opens evidence with ?sel= for ledger ids", () => {
    expect(resolveNodeRoute("demo", "K002")).toEqual({
      view: "evidence",
      path: "/p/demo/evidence",
      to: "/p/demo/evidence?sel=K002",
      kind: "claim",
    });
  });

  it("deep links into the library for cards and artifacts", () => {
    expect(resolveNodeRoute("demo", "M003")).toEqual({
      view: "library",
      path: "/p/demo/library/memory/M003",
      to: "/p/demo/library/memory/M003",
      kind: "card",
    });
    expect(resolveNodeRoute("demo", "A001").to).toBe("/p/demo/library/attempts/A001");
    expect(resolveNodeRoute("demo", "A001", "explorations").to).toBe(
      "/p/demo/library/explorations/A001",
    );
  });

  it("percent-encodes ids that carry punctuation", () => {
    expect(resolveNodeRoute("demo", "C001.v1:ob3").to).toBe(
      "/p/demo/evidence?sel=C001.v1%3Aob3",
    );
    expect(resolveNodeRoute("demo", "W001:resolution").to).toBe(
      "/p/demo?sel=W001%3Aresolution",
    );
  });
});

describe("permalinkFor", () => {
  it("is the /node/ resolver route", () => {
    expect(permalinkFor("demo", "T003")).toBe("/p/demo/node/T003");
    expect(permalinkFor("demo", "C001.v1:ob3")).toBe("/p/demo/node/C001.v1%3Aob3");
  });
});
