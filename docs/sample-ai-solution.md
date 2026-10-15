# 🧠 Duplicates? Count Them Once! | Simple C++ + Visuals

## 💡 The tiny trick

**A longer subarray doesn’t always have more distinct values.**

For `[1,2,1]`, adding the last `1` changes nothing in the set. The contribution stays `2² = 4`.

![The repeated 1 adds no new value to the set.](https://assets.leetcode.com/users/images/0f2640f0-810a-43ff-b895-4e55e45ec2e3_1792092446.6012304.gif)

*The repeated 1 adds no new value to the set.*

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

![Reset for each start, then grow right: the total reaches 15.](https://assets.leetcode.com/users/images/14481b50-91dd-4d7f-a46b-88fd75239121_1792092457.7041261.gif)

*Reset for each start, then grow right: the total reaches 15.*

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
