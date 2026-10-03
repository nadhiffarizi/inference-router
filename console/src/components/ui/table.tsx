import * as React from "react";
import { cn } from "../../lib/utils";

/** shadcn table primitives; dense rows are fine (design.md allows it for tables). */
function Table({ className, ...props }: React.HTMLAttributes<HTMLTableElement>): React.ReactElement {
  return (
    <div className="relative w-full overflow-x-auto">
      <table className={cn("w-full caption-bottom text-sm", className)} {...props} />
    </div>
  );
}

function TableHeader({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>): React.ReactElement {
  return <thead className={cn("[&_tr]:border-b", className)} {...props} />;
}

function TableBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>): React.ReactElement {
  return <tbody className={cn("[&_tr:last-child]:border-0", className)} {...props} />;
}

function TableRow({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>): React.ReactElement {
  return <tr className={cn("border-b transition-colors hover:bg-muted/50", className)} {...props} />;
}

function TableHead({ className, ...props }: React.HTMLAttributes<HTMLTableCellElement>): React.ReactElement {
  return (
    <th
      className={cn("h-10 px-3 text-left align-middle text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

function TableCell({ className, ...props }: React.HTMLAttributes<HTMLTableCellElement>): React.ReactElement {
  return <td className={cn("px-3 py-2.5 align-middle", className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableRow, TableHead, TableCell };