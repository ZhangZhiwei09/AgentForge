import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * 合并 Tailwind 类名。使用 clsx 解析条件类名 + twMerge 消除冲突。
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
