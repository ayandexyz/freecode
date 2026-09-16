import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageWrapper } from "../../components/PageWrapper";
import { POSTS, formatDate, postBySlug } from "../posts";

type Params = { slug: string };

export function generateStaticParams(): Params[] {
  return POSTS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const post = postBySlug((await params).slug);
  if (!post) return {};
  return { title: `${post.title} — FreeCode`, description: post.description };
}

export default async function BlogPost({ params }: { params: Promise<Params> }) {
  const post = postBySlug((await params).slug);
  if (!post) notFound();
  const { Body } = post;

  return (
    <PageWrapper>
      <article className="w-full max-w-3xl mx-auto px-6 py-16 md:py-24">
        <Link
          href="/blog"
          className="inline-flex items-center gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground transition-colors mb-10"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          All posts
        </Link>
        <header className="mb-12">
          <p className="font-mono text-xs text-muted-foreground/60 mb-4">
            <time dateTime={post.date}>{formatDate(post.date)}</time>
            <span className="mx-2 text-muted-foreground/40">·</span>
            {post.readingMinutes} min read
          </p>
          <h1 className="text-3xl md:text-4xl font-medium text-foreground tracking-tight leading-tight">
            {post.title}
          </h1>
          <p className="text-lg text-muted-foreground mt-5 leading-relaxed">{post.description}</p>
        </header>
        <div className="blog-prose">
          <Body />
        </div>
      </article>
    </PageWrapper>
  );
}
