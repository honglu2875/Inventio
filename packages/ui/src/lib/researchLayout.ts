import type { Graph } from "@inventio/schema";
import type { LayoutResult, Placed } from "./layout";

/** Fixed columns and stable within-round slots; selection never changes layout. */
export function layoutResearch(graph: Graph): LayoutResult {
  const nodes: Placed[] = [{ id: "problem", x: 35, y: 45, w: 230, h: 94 }];
  const rounds = graph.nodes.filter(n => n.data.subtype === "round");
  let top = 190;
  for (const round of rounds) {
    const members = graph.nodes.filter(n => n.data.roundId === round.id && n.id !== round.id);
    const place = (subtype: string, x: number, w = 290, h = 138) => {
      members.filter(n => n.data.subtype === subtype).forEach((n, i) => nodes.push({ id: n.id, x, y: top + i * 154, w, h }));
    };
    nodes.push({ id: round.id, x: 35, y: top, w: 230, h: 110 });
    place("session", 345, 280, 122);
    place("note", 2410, 240);
    place("result", 675, 290);
    place("assessment", 1045);
    place("response", 1390);
    place("summary", 1735);
    place("final", 2075);
    const count = Math.max(3, ...["result", "assessment", "response", "note"].map(type => members.filter(n => n.data.subtype === type).length));
    top += count * 154 + 100;
  }
  const width = Math.max(...nodes.map(n => n.x + n.w), 600) + 40;
  return { nodes, width, height: top + 40 };
}
