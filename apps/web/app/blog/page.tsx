import type { Metadata } from "next";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { PageWrapper } from "../components/PageWrapper";
import { POSTS, formatDate } from "./posts";

export const metadata: Metadata = {
  title: "Blog — FreeCode",
  description: "Engineering notes from building FreeCode: what we tried, what we measured, what we shipped.",
};

export default function BlogIndex() {
  return (
    <PageWrapper>
      <div className="w-full max-w-4xl mx-auto px-6 py-16 md:py-24">
        <header className="mb-12">
          <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground/60 mb-3">
            Blog
          </p>
          <h1 className="text-3xl md:text-4xl font-medium text-foreground tracking-tight">
            Engineering notes
          </h1>
          <p className="text-lg text-muted-foreground mt-3 max-w-2xl leading-relaxed">
            What we tried, what we measured, and what we shipped — including the experiments
            that lost.
          </p>
        </header>

        <ol className="divide-y divide-border border-y border-border">
          {POSTS.map((post, i) => (
            <li key={post.slug}>
              <Link
                href={`/blog/${post.slug}`}
                className="group grid gap-3 py-8 md:grid-cols-[8rem_1fr] md:gap-8"
              >
                <div className="font-mono text-xs text-muted-foreground/60 pt-1">
                  <span className="mr-2 text-muted-foreground/40">{String(i + 1).padStart(2, "0")}</span>
                  <time dateTime={post.date}>{formatDate(post.date)}</time>
                  <div className="mt-1">{post.readingMinutes} min read</div>
                </div>
                <div>
                  <h2 className="text-xl md:text-2xl font-medium text-foreground leading-snug tracking-tight group-hover:underline decoration-border underline-offset-4">
                    {post.title}
                  </h2>
                  <p className="mt-3 text-muted-foreground leading-relaxed">{post.description}</p>
                  <span className="mt-4 inline-flex items-center gap-1 font-mono text-xs text-muted-foreground group-hover:text-foreground transition-colors">
                    Read
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </PageWrapper>
  );
}
