import { GripVertical } from "lucide-react";
import * as ResizablePrimitive from "react-resizable-panels";
import { cn } from "../../lib/utils";

/**
 * Minimal shadcn Resizable surface (ResizablePanelGroup / ResizablePanel /
 * ResizableHandle) over react-resizable-panels v4. The library's public API
 * still names the parts Group/Panel/Separator, and calls the axis
 * `orientation` — mapped here to shadcn's `direction` so call sites read as
 * usual.
 *
 * ⚠️ v4 sizing: bare numbers are pixels, unitless strings are percents —
 * pass sizes as strings ("20"), never plain numbers (20 = 20px).
 */

function ResizablePanelGroup({
  className,
  direction = "horizontal",
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Group> & {
  /** shadcn-style name for the library's `orientation` ("horizontal" = columns). */
  direction?: "horizontal" | "vertical";
}): React.ReactElement {
  return <ResizablePrimitive.Group className={cn("flex h-full w-full", className)} orientation={direction} {...props} />;
}

const ResizablePanel = ResizablePrimitive.Panel;

function ResizableHandle({
  withHandle,
  className,
  ...props
}: React.ComponentProps<typeof ResizablePrimitive.Separator> & { withHandle?: boolean }): React.ReactElement {
  return (
    // w-px bg-border doubles as the divider between the panels; the invisible
    // after-strip widens the pointer grab area without moving the divider
    <ResizablePrimitive.Separator
      className={cn(
        "relative flex w-px shrink-0 items-center bg-border",
        "after:absolute after:inset-y-0 after:-left-2.5 after:w-6 after:content-['']",
        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        className,
      )}
      {...props}
    >
      {withHandle && (
        <div className="z-10 flex h-4 w-3 items-center justify-center rounded-sm border bg-border text-muted-foreground">
          <GripVertical className="size-2.5" />
        </div>
      )}
    </ResizablePrimitive.Separator>
  );
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };