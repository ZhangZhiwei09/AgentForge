import { useState } from "react";
import { ThumbsUp, ThumbsDown, Star } from "lucide-react";

interface SatisfactionRatingProps {
  sessionId: string;
  messageId?: string;
  onRated?: (rating: string) => void;
}

export function SatisfactionRating({
  sessionId,
  messageId,
  onRated,
}: SatisfactionRatingProps) {
  const [rating, setRating] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const [showStars, setShowStars] = useState(false);
  const [comment, setComment] = useState("");

  async function submitRating(value: string) {
    if (submitted) return;
    setRating(value);
    setSubmitted(true);

    try {
      await fetch("/api/customer-chat/rate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          message_id: messageId,
          rating: value,
          comment: comment || undefined,
        }),
      });
      onRated?.(value);
    } catch (err) {
      console.error("Failed to submit rating:", err);
    }
  }

  if (submitted) {
    return (
      <div className="flex items-center gap-2 text-xs text-[hsl(var(--cs-success))] animate-fade-in">
        <Star className="h-3.5 w-3.5 fill-current" />
        感谢您的反馈！
      </div>
    );
  }

  return (
    <div className="space-y-2 animate-fade-in">
      {!showStars ? (
        <div className="flex items-center gap-1">
          <span className="text-xs text-[hsl(var(--muted-foreground))] mr-1">
            这个回答有帮助吗？
          </span>
          <button
            onClick={() => submitRating("positive")}
            className="rounded-md p-1.5 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--cs-success))] hover:bg-green-50 transition-colors"
            title="有帮助"
          >
            <ThumbsUp className="h-4 w-4" />
          </button>
          <button
            onClick={() => {
              setShowStars(true);
            }}
            className="rounded-md p-1.5 text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--cs-danger))] hover:bg-red-50 transition-colors"
            title="没有帮助"
          >
            <ThumbsDown className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-[hsl(var(--muted-foreground))]">
            请告诉我们哪里做得不好？
          </p>
          <div className="flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                onClick={() => submitRating(`star_${star}`)}
                className={`rounded-md p-1 transition-colors ${
                  rating === `star_${star}`
                    ? "text-amber-500"
                    : "text-[hsl(var(--muted-foreground))] hover:text-amber-500"
                }`}
              >
                <Star
                  className={`h-5 w-5 ${
                    rating && parseInt(rating.split("_")[1]) >= star
                      ? "fill-current"
                      : ""
                  }`}
                />
              </button>
            ))}
          </div>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="补充您的反馈（可选）..."
            className="w-full rounded-lg border border-[hsl(var(--cs-border))] px-3 py-2 text-xs resize-none focus:outline-none focus:ring-2 focus:ring-[hsl(var(--cs-primary))]/20"
            rows={2}
          />
          <button
            onClick={() => submitRating("negative")}
            className="rounded-lg bg-[hsl(var(--cs-primary))] px-3 py-1.5 text-xs text-white hover:bg-[hsl(var(--cs-primary-dark))] transition-colors"
          >
            提交反馈
          </button>
        </div>
      )}
    </div>
  );
}
