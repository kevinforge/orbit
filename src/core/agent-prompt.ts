export function sanitizeAgentVisibleReply(content: string): string {
  if (!containsPrivateRoutingContext(content)) {
    return content;
  }

  return "Agent response included internal routing context and was hidden. Please retry the assignment.";
}

function containsPrivateRoutingContext(content: string): boolean {
  return content.replace(/\s+/g, "").toLowerCase().includes("[orbitprivateroutingcontext]");
}
