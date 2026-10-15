# 🧠 Duplicates? Count Them Once! | Simple C++ + Visuals

## 💡 The tiny trick

**A longer subarray doesn’t always have more distinct values.**

For `[1,2,1]`, adding the last `1` changes nothing in the set. The contribution stays `2² = 4`.

*The repeated 1 adds no new value to the set.*

| Step | State | Result |
|---|---|---|
| Start i=0 \| Extend to j=0 | Unique values: \{1\} | Contribution: 1 x 1 = 1 |
| Start i=0 \| Extend to j=1 | Unique values: \{1, 2\} | Contribution: 2 x 2 = 4 |
| Start i=0 \| Extend to j=2 | Unique values: \{1, 2\} | Contribution: 2 x 2 = 4 |

---

## 🎯 Three moves

- Fix `i` and start with an empty set.
- Extend `j`, inserting `nums[j]`.
- Add `st.size()²` to `ans`.

---

> **Why it works:** after each insert, `st` contains exactly the values in `nums[i..j]`; the loops visit every subarray once.

---

## 🎬 Watch the answer grow

`nums = [1,2,1]` → six subarrays, six contributions.

**1 + 4 + 4 + 1 + 4 + 1 = 15**

*Reset for each start, then grow right: the total reaches 15.*

| Step | State | Result |
|---|---|---|
| Subarray nums\[0..0\] | Set: \{1\} \| distinct: 1 | + 1   -&gt;   answer = 1 |
| Subarray nums\[0..1\] | Set: \{1, 2\} \| distinct: 2 | + 4   -&gt;   answer = 5 |
| Subarray nums\[0..2\] | Set: \{1, 2\} \| distinct: 2 | + 4   -&gt;   answer = 9 |
| Subarray nums\[1..1\] | Set: \{2\} \| distinct: 1 | + 1   -&gt;   answer = 10 |
| Subarray nums\[1..2\] | Set: \{1, 2\} \| distinct: 2 | + 4   -&gt;   answer = 14 |
| Subarray nums\[2..2\] | Set: \{1\} \| distinct: 1 | + 1   -&gt;   answer = 15 |

---

> **Remember:** reset the set when the left boundary moves. Reuse it while the right boundary grows.

## ⏱️ Complexity

| | Cost | Why |
|---|---|---|
| Time | `O(n²) expected, O(n³) worst-case` | n = nums.size(); O(n²) inserts, expected O(1) each. Hash collisions can degrade insertion; size() stays O(1). |
| Space | `O(n)` | One set holds at most n distinct values. |

## 💻 Accepted code

```cpp
class Solution {
public:
    int sumCounts(vector<int>& nums) {
        int n = nums.size();
        int ans = 0;

        for (int i = 0; i < n; i++) {
            unordered_set<int> st;

            for (int j = i; j < n; j++) {
                st.insert(nums[j]);

                int distinct = st.size();
                ans += distinct * distinct;
            }
        }

        return ans;
    }
};
```
