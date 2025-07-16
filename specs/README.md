# Specifications

This directory contains specifications for the `ji` command-line tool, written in EARS (Easy Approach to Requirements Syntax).

## EARS Syntax

EARS is a syntax for writing requirements that is easy to learn and use. It is designed to be used by people who are not familiar with formal requirements engineering notations.

The basic EARS template is:

**<optional precondition> <optional trigger> the <system name> shall <system response>**

Here are the main EARS patterns:

*   **Universal Requirements:** These are always active.
    *   `The <system name> shall <system response>.`
*   **State Driven Requirements:** These are active when the system is in a specific state.
    *   `While <a specific state>, the <system name> shall <system response>.`
*   **Event Driven Requirements:** These are triggered by a specific event.
    *   `When <triggering event>, the <system name> shall <system response>.`
*   **Optional Feature Requirements:** These are only active when a specific feature is enabled.
    *   `Where <feature is included>, the <system name> shall <system response>.`
*   **Unwanted Behaviour Requirements:** These specify what the system should not do.
    *   `If <optional precondition>, then the <system name> shall not <system response>.`
*   **Complex Requirements:** These combine multiple triggers and preconditions.
    *   `When <trigger> if <precondition>, the <system name> shall <system response>.`
