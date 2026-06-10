import { ChevronRight } from "lucide-react";

interface QuickRepliesProps {
    suggestions: string[];
    onSelect: (text: string) => void;
}

export function QuickReplies({ suggestions, onSelect }: QuickRepliesProps) {
    if (!suggestions || suggestions.length === 0) return null;

    return (
        <div className="flex flex-wrap gap-2 mt-3 animate-fade-in">
            <span className="text-xs text-[hsl(var(--muted-foreground))] self-center mr-1">
                猜你想问：
            </span>
            {suggestions.map((s, i) => (
                <button
                    key={i}
                    onClick={() => onSelect(s)}
                    className="inline-flex items-center gap-1 rounded-full border border-[hsl(var(--cs-border))] bg-white px-3 py-1.5 text-xs text-[hsl(var(--cs-primary))] hover:bg-[hsl(var(--cs-primary-light))] hover:border-[hsl(var(--cs-primary))] transition-colors"
                >
                    {s}
                    <ChevronRight className="h-3 w-3" />
                </button>
            ))}
        </div>
    );
}
