(function (): import("./immediate_queue-types").ImmediateQueueConstructor {
  type Link<T> = { value: T; next: Link<T> | null };
  type Queue<T> = import("./immediate_queue-types").ImmediateQueue<T>;
  class ImmediateQueue<T> implements Queue<T> {
    #first: Link<T> | null = null;
    #last: Link<T> | null = null;
    #length = 0;
    get length() { return this.#length; }
    push(value: T) {
      const link: Link<T> = { value, next: null };
      if (this.#last) this.#last.next = link;
      else this.#first = link;
      this.#last = link;
      this.#length++;
    }
    pushFront(value: T) {
      const link: Link<T> = { value, next: this.#first };
      if (!this.#last) this.#last = link;
      this.#first = link;
      this.#length++;
    }
    shift() {
      const link = this.#first;
      if (!link) return undefined;
      this.#first = link.next;
      if (!this.#first) this.#last = null;
      this.#length--;
      link.next = null;
      return link.value;
    }
  }
  return ImmediateQueue;
});
