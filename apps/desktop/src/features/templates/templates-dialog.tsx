import { FilePlus2, LayoutTemplate, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PAGE_TEMPLATES, type PageTemplate } from "@/features/templates/page-templates";

interface TemplatesDialogProps {
  onChoose: (template: PageTemplate) => void;
  onClose: () => void;
}

export function TemplatesDialog({ onChoose, onClose }: TemplatesDialogProps) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-6 backdrop-blur-sm">
      <section
        aria-label="Page templates"
        aria-modal="true"
        role="dialog"
        className="flex max-h-[78vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-white/10 bg-[#1d1d21] shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-white/8 px-5 py-4">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
              <LayoutTemplate className="size-5 text-violet-300" /> New page from template
            </h2>
            <p className="mt-1 text-xs text-neutral-500">Templates create editable local pages; no cloud service is required.</p>
          </div>
          <Button aria-label="Close templates" size="icon" variant="ghost" onClick={onClose}>
            <X className="size-4" />
          </Button>
        </header>
        <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-4 md:grid-cols-2">
          {PAGE_TEMPLATES.map((template) => (
            <button
              key={template.id}
              className="rounded-xl border border-white/8 bg-white/[0.025] p-4 text-left transition-colors hover:border-violet-500/40 hover:bg-violet-500/8"
              onClick={() => onChoose(template)}
            >
              <div className="mb-3 grid size-9 place-items-center rounded-lg bg-violet-500/12 text-violet-300">
                <FilePlus2 className="size-4" />
              </div>
              <div className="text-sm font-semibold text-neutral-100">{template.name}</div>
              <div className="mt-1 text-xs leading-5 text-neutral-500">{template.description}</div>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
