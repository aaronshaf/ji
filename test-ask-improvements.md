# Test Plan for Improved `ji ask` Functionality

## Improvements Implemented

1. **Iterative Document Analysis**
   - Pre-analyzes the question to understand what specific information is needed
   - Uses this analysis to guide document section extraction
   - Implements a smarter chunking and scoring system for large documents

2. **Smart Context Extraction**
   - For large documents (>5000 chars), uses intelligent section extraction
   - Fast path for documents with direct title matches
   - Keyword-based scoring to identify relevant chunks without expensive LLM calls
   - Extends chunks to natural paragraph boundaries
   - Merges adjacent relevant sections

3. **Performance Optimizations**
   - Parallel processing of document context extraction
   - Reduced temperature for analysis tasks (0.1-0.3) for more consistent results
   - Avoids expensive LLM calls for obviously irrelevant content

4. **Better Context Engineering**
   - Analyzes question type to determine best sources (Jira vs Confluence)
   - Uses memory system to boost previously helpful documents
   - Implements 3-round search strategy with different focuses

## Test Cases

### Test 1: Team Ownership Question
```bash
ji ask "what team works on Gradebook"
```
Expected: Should extract specific sections mentioning team names, ownership, or responsibility for Gradebook

### Test 2: Technical Implementation Question
```bash
ji ask "how does the authentication system work"
```
Expected: Should find and extract technical details, API information, and implementation specifics

### Test 3: Recent Activity Question
```bash
ji ask "what issues were reported lately for the dashboard"
```
Expected: Should search Jira primarily and extract recent issue information

### Test 4: Large Document Analysis
```bash
ji ask "what are the configuration options for the search feature"
```
Expected: Should intelligently extract configuration-related sections from large documents

## Verification Steps

1. Run each test case and observe:
   - Whether the question analysis correctly identifies what to search for
   - If large documents are processed with smart extraction (not just beginning)
   - Whether relevant sections are properly identified and extracted
   - If the context provided to the LLM is focused and relevant

2. Compare with previous implementation:
   - Should provide more targeted context
   - Should handle "who" questions better by finding team/ownership information
   - Should be faster for large documents due to optimized extraction