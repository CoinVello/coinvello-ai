<?php

declare(strict_types=1);

namespace CoinVello\Sdk;

/**
 * One page of a cursor-paginated list, with an iterator over all pages.
 */
final class ListPage implements \IteratorAggregate, \Countable
{
    /** @param array<string,mixed> $page */
    public function __construct(
        private readonly HttpClient $http,
        private readonly string $path,
        private readonly array $params,
        private array $page,
    ) {
    }

    /** @return array<int,array<string,mixed>> */
    public function data(): array { return $this->page['data'] ?? []; }
    public function hasMore(): bool { return (bool) ($this->page['has_more'] ?? false); }
    public function nextCursor(): ?string { return $this->page['next_cursor'] ?? null; }
    public function count(): int { return count($this->data()); }
    /** @return array<string,mixed> */
    public function toArray(): array { return $this->page; }

    public function nextPage(): ?ListPage
    {
        if (!$this->hasMore() || $this->nextCursor() === null) {
            return null;
        }
        $params = $this->params + ['cursor' => $this->nextCursor()];
        $params['cursor'] = $this->nextCursor();
        return new ListPage($this->http, $this->path, $this->params, $this->http->get($this->path, $params));
    }

    /** Iterate the current page only. */
    public function getIterator(): \ArrayIterator
    {
        return new \ArrayIterator($this->data());
    }

    /** Iterate every item across all pages. */
    public function autoPagingIterator(): \Generator
    {
        $page = $this;
        while ($page !== null) {
            foreach ($page->data() as $item) {
                yield $item;
            }
            $page = $page->nextPage();
        }
    }
}
