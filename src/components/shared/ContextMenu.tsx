// src/components/shared/ContextMenu.tsx
import { useState, useEffect, type ReactNode } from "react";
import { ArrowLeft, Check } from "lucide-react";
import { useOverlay } from "../../lib/overlayStack";

export interface ContextSubItem {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  checked?: boolean;
  indent?: number;
  divider?: boolean;
}

export interface ContextMenuItem {
  label: string;
  icon?: ReactNode;
  onClick?: () => void;
  variant?: "danger" | "default";
  divider?: boolean;
  submenu?: {
    title: string;
    items: ContextSubItem[];
  };
}

interface ContextMenuProps {
  items: ContextMenuItem[];
  children: ReactNode;
}

export function ContextMenu({ items, children }: ContextMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [activeSubmenu, setActiveSubmenu] = useState<ContextMenuItem["submenu"] | null>(null);

  const openAt = (clientX: number, clientY: number) => {
    const x = Math.max(8, Math.min(clientX, window.innerWidth - 220));
    const y = Math.max(8, Math.min(clientY, window.innerHeight - items.length * 36 - 16));
    setPosition({ x, y });
    setActiveSubmenu(null);
    setOpen(true);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    openAt(e.clientX, e.clientY);
  };

  const handleKeyboardMenu = (e: React.KeyboardEvent) => {
    if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openAt(rect.left + 16, rect.bottom + 4);
  };

  // Escape rides the dismissal ladder: first press closes the submenu,
  // the next closes the menu — without leaking to listeners behind it.
  useOverlay(open, () => {
    if (activeSubmenu) setActiveSubmenu(null);
    else setOpen(false);
  });

  useEffect(() => {
    if (!open) return;
    const handleClick = () => { setOpen(false); setActiveSubmenu(null); };
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, [open]);

  return (
    <>
      <div onContextMenu={handleContextMenu} onKeyDown={handleKeyboardMenu}>{children}</div>
      {open && (
        <div
          role="menu"
          className="glass-float fixed z-[70] rounded-lg py-1 min-w-[180px] max-w-[240px] menu-dropdown-left"
          style={{
            left: position.x,
            top: position.y,
          }}
          onClick={e => e.stopPropagation()}
        >
          {!activeSubmenu ? (
            // Panel A: main items
            items.map((item, i) => (
              <div key={i}>
                {item.divider && <div className="my-1 border-t border-border" />}
                <button
                  type="button"
                  role="menuitem"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (item.submenu) {
                      setActiveSubmenu(item.submenu);
                    } else {
                      item.onClick?.();
                      setOpen(false);
                    }
                  }}
                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-body-sm text-left transition-colors ${
                    item.variant === "danger"
                      ? "text-recording hover:bg-recording/10"
                      : "text-text-secondary hover:text-text-primary hover:bg-bg-hover"
                  }`}
                >
                  {item.icon && <span className="shrink-0 opacity-70">{item.icon}</span>}
                  <span className="flex-1">{item.label}</span>
                  {item.submenu && <span className="text-text-muted text-caption">›</span>}
                </button>
              </div>
            ))
          ) : (
            // Panel B: submenu
            <>
              <button
                type="button"
                role="menuitem"
                onClick={e => { e.stopPropagation(); setActiveSubmenu(null); }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-caption text-text-muted hover:text-text-primary hover:bg-bg-hover transition-colors"
              >
                <ArrowLeft size={12} />
                {activeSubmenu.title}
              </button>
              <div className="my-1 border-t border-border" />
              {activeSubmenu.items.map((sub, i) => (
                <div key={i}>
                  {sub.divider && <div className="my-1 border-t border-border" />}
                  <button
                    type="button"
                    role="menuitem"
                    onClick={e => {
                      e.stopPropagation();
                      sub.onClick();
                      setOpen(false);
                      setActiveSubmenu(null);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-body-sm text-left text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
                    style={{ paddingLeft: `${12 + (sub.indent ?? 0) * 12}px` }}
                  >
                    {sub.icon && <span className="shrink-0 opacity-70">{sub.icon}</span>}
                    <span className="flex-1 truncate">{sub.label}</span>
                    {sub.checked && <Check size={12} className="text-accent shrink-0" />}
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}
