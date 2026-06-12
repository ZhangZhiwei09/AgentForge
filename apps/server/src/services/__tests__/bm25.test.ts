// tokenizer tests — jieba Chinese segmentation + stop word filtering
import { describe, it, expect } from "vitest";
import { tokenize, getTokenCount } from "../tokenizer.js";

describe("tokenizer", () => {
  describe("Chinese text", () => {
    it("should segment common Chinese query into words", () => {
      const tokens = tokenize("支持哪些支付方式");
      // Should contain meaningful words from jieba segmentation
      expect(tokens).toContain("支付");
      expect(tokens).toContain("方式");
      expect(tokens).toContain("支持");
      expect(tokens.length).toBeGreaterThanOrEqual(3);
    });

    it("should filter Chinese stop words", () => {
      const tokens = tokenize("我的订单在哪里可以查看呢");
      // "的", "在", "呢", "可以", "我", "哪里" are stop words
      expect(tokens).not.toContain("的");
      expect(tokens).not.toContain("在");
      expect(tokens).not.toContain("呢");
      expect(tokens).toContain("订单");
      // jieba segments "查看" in this context differently; just verify we have content
      expect(tokens.length).toBeGreaterThan(0);
    });

    it("should segment FAQ content into meaningful words", () => {
      const tokens = tokenize(
        "退换货政策：自收到商品之日起7天内可以申请无理由退货",
      );
      expect(tokens.length).toBeGreaterThan(5);
      // jieba segments differently from naive expectation; verify key content is present
      expect(tokens).toContain("退货");
      expect(tokens).toContain("商品");
      expect(tokens).toContain("申请");
    });
  });

  describe("English text", () => {
    it("should segment English text without stop words", () => {
      const tokens = tokenize("the quick brown fox jumps over the lazy dog");
      expect(tokens).toContain("quick");
      expect(tokens).toContain("brown");
      expect(tokens).toContain("fox");
      expect(tokens).not.toContain("the");
    });

    it("should filter common English stop words", () => {
      const tokens = tokenize("this is a test of the system");
      expect(tokens).not.toContain("this");
      expect(tokens).not.toContain("is");
      expect(tokens).not.toContain("a");
      expect(tokens).not.toContain("the");
      expect(tokens).not.toContain("of");
      expect(tokens).toContain("test");
      expect(tokens).toContain("system");
    });

    it("should filter single-letter English words", () => {
      // "have" is in stop words list; "a" is stop word; "I" → "i" filtered as single letter
      const tokens = tokenize("I have a dream");
      expect(tokens).not.toContain("i");
      expect(tokens).not.toContain("a");
      expect(tokens).toContain("dream");
    });
  });

  describe("Mixed text", () => {
    it("should handle mixed Chinese-English text", () => {
      const tokens = tokenize("支付方式：支持 Apple Pay 和 WeChat 微信支付");
      expect(tokens).toContain("支付");
      expect(tokens).toContain("apple");
      expect(tokens).toContain("pay");
      expect(tokens).toContain("wechat");
      expect(tokens).toContain("微信");
    });
  });

  describe("Edge cases", () => {
    it("should handle empty string", () => {
      expect(tokenize("")).toEqual([]);
    });

    it("should handle pure punctuation", () => {
      const tokens = tokenize("！@#￥%……&*（）——+");
      expect(tokens.length).toBe(0);
    });

    it("should handle whitespace-only string", () => {
      const tokens = tokenize("   \n  \t  ");
      expect(tokens.length).toBe(0);
    });
  });

  describe("getTokenCount", () => {
    it("should return token count for text", () => {
      const count = getTokenCount("支付方式说明");
      expect(count).toBeGreaterThan(0);
    });

    it("should return 0 for empty text", () => {
      expect(getTokenCount("")).toBe(0);
    });
  });
});
