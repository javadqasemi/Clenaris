import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Markdown-Darstellung für Blogartikel.
 *
 * Architekturentscheid: ein eigener, sehr kleiner Parser statt `react-markdown`
 * plus `remark`/`rehype`. Die Inhalte stammen ausschliesslich aus dem eigenen
 * Redaktionssystem — es gibt keine Benutzereingaben, die HTML einschleusen
 * könnten. Der unterstützte Umfang (Überschriften, Absätze, Listen, Fett,
 * Kursiv, Links, Code, Zitate) deckt alles ab, was im Ratgeber vorkommt, und
 * spart rund 40 KB im Bundle.
 *
 * Jeder Text wird escaped, bevor Inline-Auszeichnungen angewendet werden — so
 * bleibt auch bei einem versehentlich eingefügten HTML-Schnipsel alles sicher.
 */

interface Block {
  type: 'h2' | 'h3' | 'p' | 'ul' | 'ol' | 'quote' | 'code';
  content: string;
  items?: string[];
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Nur Ziele, die ein Browser als Adresse behandelt — nie als Programm.
 *
 * `[Text](javascript:…)` wäre nach dem Escapen weiterhin ein gültiges
 * `href`, und `escapeHtml` schützt nur vor Markup, nicht vor Protokollen. Die
 * Texte hier schreibt die Redaktion, aber `blog:update` besitzt auch die
 * Betriebsleitung — und ein Link, der auf jeder Besucherseite Skript ausführt,
 * ist zu viel Vertrauen in ein einzelnes Konto. Erlaubt sind Web-, Mail- und
 * Telefonadressen sowie Pfade dieser Anwendung; alles andere wird zu `#`.
 */
function safeHref(target: string): string {
  const value = target.trim();
  if (/^(https?:|mailto:|tel:)/i.test(value)) return value;
  if (value.startsWith('/') && !value.startsWith('//')) return value;
  if (value.startsWith('#')) return value;
  return '#';
}

/** Fett, kursiv, Code und Links — in dieser Reihenfolge. */
function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code class="rounded bg-muted px-1.5 py-0.5 text-[0.875em]">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold text-foreground">$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      (_match, label: string, target: string) =>
        `<a href="${safeHref(target)}" rel="noopener" class="font-medium text-primary underline underline-offset-4">${label}</a>`,
    );
}

function parse(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index++;
      continue;
    }

    // Codeblock
    if (line.startsWith('```')) {
      const code: string[] = [];
      index++;
      while (index < lines.length && !lines[index].startsWith('```')) {
        code.push(lines[index]);
        index++;
      }
      index++;
      blocks.push({ type: 'code', content: code.join('\n') });
      continue;
    }

    // Überschriften
    if (line.startsWith('### ')) {
      blocks.push({ type: 'h3', content: line.slice(4) });
      index++;
      continue;
    }
    if (line.startsWith('## ')) {
      blocks.push({ type: 'h2', content: line.slice(3) });
      index++;
      continue;
    }
    if (line.startsWith('# ')) {
      blocks.push({ type: 'h2', content: line.slice(2) });
      index++;
      continue;
    }

    // Zitat
    if (line.startsWith('> ')) {
      const quote: string[] = [];
      while (index < lines.length && lines[index].startsWith('> ')) {
        quote.push(lines[index].slice(2));
        index++;
      }
      blocks.push({ type: 'quote', content: quote.join(' ') });
      continue;
    }

    // Aufzählung
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*] /.test(lines[index])) {
        items.push(lines[index].slice(2));
        index++;
      }
      blocks.push({ type: 'ul', content: '', items });
      continue;
    }

    // Nummerierte Liste
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\d+\. /.test(lines[index])) {
        items.push(lines[index].replace(/^\d+\. /, ''));
        index++;
      }
      blocks.push({ type: 'ol', content: '', items });
      continue;
    }

    // Absatz — bis zur nächsten Leerzeile
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^(#{1,3} |[-*] |\d+\. |> |```)/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index++;
    }
    blocks.push({ type: 'p', content: paragraph.join(' ') });
  }

  return blocks;
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  const blocks = React.useMemo(() => parse(content), [content]);

  return (
    <div className={cn('space-y-6', className)}>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'h2':
            return (
              <h2
                key={index}
                className="prose-measure pt-6 text-title font-bold tracking-tight"
                // eslint-disable-next-line react/no-danger -- Inhalt aus dem eigenen Redaktionssystem, escaped
                dangerouslySetInnerHTML={{ __html: inline(block.content) }}
              />
            );

          case 'h3':
            return (
              <h3
                key={index}
                className="prose-measure pt-4 font-display text-xl font-semibold tracking-tight"
                // eslint-disable-next-line react/no-danger -- escaped
                dangerouslySetInnerHTML={{ __html: inline(block.content) }}
              />
            );

          case 'ul':
            return (
              <ul key={index} className="prose-measure space-y-2">
                {block.items?.map((item, itemIndex) => (
                  <li key={itemIndex} className="flex gap-3 leading-relaxed text-muted-foreground">
                    <span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                    {/* eslint-disable-next-line react/no-danger -- escaped */}
                    <span dangerouslySetInnerHTML={{ __html: inline(item) }} />
                  </li>
                ))}
              </ul>
            );

          case 'ol':
            return (
              <ol key={index} className="prose-measure space-y-2">
                {block.items?.map((item, itemIndex) => (
                  <li key={itemIndex} className="flex gap-3 leading-relaxed text-muted-foreground">
                    <span className="shrink-0 font-semibold tabular-nums text-primary">
                      {itemIndex + 1}.
                    </span>
                    {/* eslint-disable-next-line react/no-danger -- escaped */}
                    <span dangerouslySetInnerHTML={{ __html: inline(item) }} />
                  </li>
                ))}
              </ol>
            );

          case 'quote':
            return (
              <blockquote
                key={index}
                className="prose-measure border-l-2 border-primary pl-5 text-lg italic leading-relaxed"
                // eslint-disable-next-line react/no-danger -- escaped
                dangerouslySetInnerHTML={{ __html: inline(block.content) }}
              />
            );

          case 'code':
            return (
              <pre
                key={index}
                className="overflow-x-auto rounded-xl border border-border bg-muted p-4 text-sm"
              >
                <code>{block.content}</code>
              </pre>
            );

          case 'p':
          default:
            return (
              <p
                key={index}
                className="prose-measure leading-relaxed text-muted-foreground"
                // eslint-disable-next-line react/no-danger -- escaped
                dangerouslySetInnerHTML={{ __html: inline(block.content) }}
              />
            );
        }
      })}
    </div>
  );
}
