// Smoke-test fixture for the snippet-extractor (C++).
// Demonstrates a CLASS marker (whole class body, trailing semicolon swallowed)
// and a marker on an out-of-class METHOD definition.
#include <cstddef>

// extract-code cpp-class
class RingBuffer {
 public:
  explicit RingBuffer(size_t capacity) : capacity_(capacity) {}

  bool push(int value);

  // A token the rendered docs must never show — proves `ignore` strips it.
  // extract-code ignore
  const char* api_key_ = "sk-do-not-leak";

 private:
  size_t capacity_;
  size_t size_ = 0;
  int data_[64];
};

// extract-code cpp-method
bool RingBuffer::push(int value) {
  if (size_ == capacity_) {
    return false;
  }
  data_[size_++] = value;
  return true;
}
