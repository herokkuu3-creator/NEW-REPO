# Squaring Distinct Counts by Expanding Every Start

## What Squaring Distinctness Really Counts

For each non-empty contiguous subarray we need *how many different values appear*, then we square that number and add it to the answer. Squaring makes a subarray with 2 distinct values contribute **4 times** as much as one with 1 distinct value, so we cannot just count occurrences. With *n ≤ 100* the total number of subarrays is *n·(n+1)/2 ≤ 5050*, which is tiny. That invites a *brute-force enumeration* where we fix a left border *i* and grow the right border *j* step by step. The key observation is incremental growth: when we extend *nums[i..j-1]* to *nums[i..j]*, the set of distinct values either stays the same or gains exactly *nums[j]*. So if we keep a single set for the current *i* and keep inserting *nums[j]*, we can get the distinct count for every subarray starting at *i* in order without recomputing from scratch. ✨ This is the intuition behind the double loop with a fresh *unordered_set* per *i*.

## How the Double Loop Maintains the Distinct Set

The submitted C++ code does exactly the incremental enumeration described. It initializes *ans = 0* and *n = nums.size()*. For each *i* from *0* to *n-1* it creates an empty *`unordered_set<int>` st*. This set is the **invariant holder** for the current start. Then for each *j* from *i* to *n-1* it performs *st.insert(nums[j])*. After insertion, *st* equals *{ distinct values in nums[i..j] }*. It reads *distinct = st.size()* which in C++ is **constant-time**, *O(1)*, even if many hash collisions exist — it simply returns a stored counter, it does *not* traverse buckets. Then it adds *distinct * distinct* to *ans*. No optimization, no early break, no sorting, no frequency array is used; the code *exactly* relies on hash set semantics. The outer loop then discards *st* and starts anew for *i+1*, so subarrays with different left borders never interfere. There is *no recursion* and no extra helper function; all work is iterative with two nested *for* loops.

## Why the Answer Is Exactly the Sum of Squares

We argue by a loop invariant. *Invariant for fixed i:* before iteration *j*, *st = set(nums[i..j-1])*, and after *st.insert(nums[j])* we have *st = set(nums[i..j])*. Initialization: for *j = i*, *st* is empty, after insertion it is *{nums[i]}*, which is correct for the single-element subarray. Maintenance: assuming it holds for *j-1*, inserting *nums[j]* adds at most one new distinct value, so the property holds for *j*. Therefore *st.size()* equals the true number of distinct values in *nums[i..j]* and *st.size()* squared is the required contribution of that subarray. The outer loop enumerates *every* pair *(i,j)* with *0 ≤ i ≤ j < n* exactly once, covering all *n·(n+1)/2* non-empty contiguous subarrays and no others. Summation of *distinct²* over all those pairs is therefore precisely the definition. Edge cases line up: *n = 1* yields one iteration and *1* is added; all equal values like *[5,5,5]* keeps *st = {5}* so each contribution is *1*; all distinct like *[1,2,3]* makes *st* grow by one each *j*; *nums[i]* up to *100* and *n* up to *100* keeps *ans* at most *5050·10000 = 50,500,000* which safely fits in a 32-bit *int*, but for larger *n* an *int* would overflow and a *64-bit* type would be needed.

## Step by Step Walkthrough on a Small Example

Take *nums = [1, 2, 1]* which should give *15*. The code proceeds start by start:

| i | j | subarray *nums[i..j]* | *st* after insert | distinct | *distinct²* | running *ans* |
|---|---|---|---|---|---|---|
| 0 | 0 | [1] | {1} | 1 | 1 | 1 |
| 0 | 1 | [1,2] | {1,2} | 2 | 4 | 5 |
| 0 | 2 | [1,2,1] | {1,2} | 2 | 4 | 9 |
| 1 | 1 | [2] | {2} | 1 | 1 | 10 |
| 1 | 2 | [2,1] | {2,1} | 2 | 4 | 14 |
| 2 | 2 | [1] | {1} | 1 | 1 | 15 |

Notice how *st* is **reset** when *i* increments: after finishing *i=0* with *{1,2}*, the next iteration starts with *{}* for *i=1*. The insertion of the second *1* at *i=0, j=2* causes no growth, so distinct stays *2* — this is the *duplicate does not increase distinct count* behavior the set provides. Adding the six squared contributions *1 + 4 + 4 + 1 + 4 + 1 = 15* matches the expected result. Inline view: *i=0 → grows 1→2→2*, *i=1 → grows 1→2*, *i=2 → 1*. 🎯

## What This Pattern Teaches About Hash Sets and Complexity

*Auxiliary storage:* For each *i* the set holds at most *n* integers and at most *U = 100* distinct values given the constraints, so **space is *O(n)* or *O(min(n,U))* plus *O(1)* for loop counters**; no recursion stack is used.

*C++ hash nuance:* *`unordered_set<int>`* uses a library-provided hash function for integer keys and maintains its size separately. Therefore *size()* is *O(1)* **regardless of collisions**. Only *insert* and *find* are affected by collisions: *expected O(1)* per operation with a good hash, *worst-case O(k)* where *k* is the current set size when many keys collide into one bucket. Do not conflate *size()* with *insert* cost.

*Time:* Let *n = nums.size()*. There are *O(n²)* insert operations in total. With expected hash behavior this is **expected time *O(n²)***, which for *n=100* is trivial. In a pathological hash-collision scenario each insert could degrade to *O(n)*, giving **worst-case *O(n³)* time**. With integer keys this worst case is theoretical rather than practical, but it is the correct distinction between expected and worst-case bounds. Variables to state: *n* for length, *d* for current distinct count (*d ≤ n*). The style of *fresh set per left border + expand right* is reusable for many small-*n* subarray distinct problems.

## ⏱️ Complexity

**Time Complexity:** `O(n²) expected, O(n³) worst-case` — n = nums.size(). O(n²) subarrays, each does one unordered_set insert expected O(1) so expected O(n²). size() is O(1) always. Worst-case hash collisions make each insert O(n), giving O(n³).

**Space Complexity:** `O(n)` — unordered_set holds at most n distinct ints for current start i, plus O(1) counters; no recursion, at most O(min(n,100)) distinct values.

# Code
```cpp []
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