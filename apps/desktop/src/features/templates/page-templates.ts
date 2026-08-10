export interface PageTemplate {
  id: string;
  name: string;
  description: string;
  title: string;
  contentJson: string;
  plainText: string;
}

function doc(content: unknown[]): string {
  return JSON.stringify({ type: "doc", content });
}

function heading(text: string, level = 2) {
  return { type: "heading", attrs: { level }, content: [{ type: "text", text }] };
}

function paragraph(text = "") {
  return text
    ? { type: "paragraph", content: [{ type: "text", text }] }
    : { type: "paragraph" };
}

function task(text: string) {
  return {
    type: "taskList",
    content: [
      {
        type: "taskItem",
        attrs: { checked: false },
        content: [{ type: "paragraph", content: [{ type: "text", text }] }],
      },
    ],
  };
}

export const PAGE_TEMPLATES: PageTemplate[] = [
  {
    id: "blank",
    name: "Blank page",
    description: "An empty page for free-form notes.",
    title: "Untitled page",
    contentJson: doc([paragraph()]),
    plainText: "",
  },
  {
    id: "meeting",
    name: "Meeting notes",
    description: "Agenda, decisions, discussion, and action items.",
    title: "Meeting notes",
    contentJson: doc([
      heading("Meeting details"),
      paragraph("Date: "),
      paragraph("Attendees: "),
      heading("Agenda"),
      task("Agenda item"),
      heading("Discussion"),
      paragraph(),
      heading("Decisions"),
      paragraph(),
      heading("Action items"),
      task("Owner — action — due date"),
    ]),
    plainText: "Meeting details\n\nDate:\n\nAttendees:\n\nAgenda\n\nAgenda item\n\nDiscussion\n\nDecisions\n\nAction items\n\nOwner — action — due date",
  },
  {
    id: "project",
    name: "Project plan",
    description: "Goals, scope, milestones, risks, and next actions.",
    title: "Project plan",
    contentJson: doc([
      heading("Goal"),
      paragraph("Describe the outcome this project must achieve."),
      heading("Scope"),
      paragraph("In scope:"),
      paragraph("Out of scope:"),
      heading("Milestones"),
      task("Milestone 1"),
      task("Milestone 2"),
      heading("Risks"),
      paragraph(),
      heading("Next actions"),
      task("First action"),
    ]),
    plainText: "Goal\n\nDescribe the outcome this project must achieve.\n\nScope\n\nIn scope:\n\nOut of scope:\n\nMilestones\n\nMilestone 1\n\nMilestone 2\n\nRisks\n\nNext actions\n\nFirst action",
  },
  {
    id: "cornell",
    name: "Cornell notes",
    description: "Structured cues, notes, and summary for study.",
    title: "Cornell notes",
    contentJson: doc([
      heading("Topic"),
      paragraph("Course / source / date"),
      heading("Questions and cues"),
      paragraph(),
      heading("Notes"),
      paragraph(),
      heading("Summary"),
      paragraph(),
    ]),
    plainText: "Topic\n\nCourse / source / date\n\nQuestions and cues\n\nNotes\n\nSummary",
  },
  {
    id: "journal",
    name: "Daily journal",
    description: "Priorities, notes, gratitude, and reflection.",
    title: "Daily journal",
    contentJson: doc([
      heading("Top priorities"),
      task("Priority 1"),
      task("Priority 2"),
      task("Priority 3"),
      heading("Notes"),
      paragraph(),
      heading("Gratitude"),
      paragraph(),
      heading("Reflection"),
      paragraph(),
    ]),
    plainText: "Top priorities\n\nPriority 1\n\nPriority 2\n\nPriority 3\n\nNotes\n\nGratitude\n\nReflection",
  },
];
