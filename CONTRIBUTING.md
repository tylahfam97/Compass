Contributing to Compass

Thank you for considering contributing to Compass.

Compass is an independent, open-source project built to provide private, local-first financial guidance and budgeting tools. You do not need to be a professional developer, financial expert, or long-time open-source contributor to help.

Hobbyists, learners, designers, privacy advocates, finance enthusiasts, and curious users are all welcome here.

Ways You Can Contribute

Contributions are not limited to writing code. Helpful contributions include:

Fixing bugs
Improving documentation
Suggesting usability improvements
Testing Compass on different systems
Improving accessibility
Reviewing pull requests
Designing icons, layouts, or interface concepts
Improving financial calculations or explanations
Adding tests
Reporting confusing behavior
Suggesting new features
Helping other users in discussions

Small improvements are valuable. A contribution does not need to be large or technically complex to matter.

Before You Begin

Please search the existing issues and pull requests before opening something new. Someone may already be working on the same idea.

For significant features or architectural changes, open an issue or discussion before investing substantial time. This gives everyone a chance to discuss the idea and avoid duplicated work.

For small bug fixes, documentation corrections, tests, and minor quality-of-life improvements, you can usually open a pull request directly.

Getting Started
Fork the repository.
Clone your fork:
git clone https://github.com/YOUR-USERNAME/Compass.git
cd Compass
Create a branch for your contribution:
git checkout -b feature/short-description

Examples:

feature/monthly-spending-chart
fix/import-rounding-error
docs/improve-setup-guide
Follow the setup instructions in the project README.
Make your changes.
Test the application locally.
Commit your changes with a clear message:
git commit -m "Improve transaction import error handling"
Push the branch to your fork:
git push origin feature/short-description
Open a pull request against the main Compass repository.
Pull Request Guidelines

A good pull request should:

Focus on one change or closely related group of changes
Explain what was changed
Explain why the change is useful
Include testing steps
Mention any known limitations
Include screenshots or recordings for visible interface changes
Update documentation when behavior changes

You do not need to write a perfect description. Clear and honest is better than formal.

A useful pull request description might look like this:

## What changed

Added clearer validation messages when a transaction import fails.

## Why

The previous error message did not explain which rows caused the import to fail.

## Testing

- Imported a valid CSV file
- Imported files with missing dates
- Imported files with invalid amounts
- Confirmed existing imports still work

## Screenshots

Add screenshots here when applicable.

Maintainers may suggest changes or ask questions during review. This is a normal part of collaboration and is not a rejection of your work.

Reporting Bugs

When reporting a bug, include as much of the following information as you reasonably can:

What you expected to happen
What actually happened
Steps to reproduce the problem
Your operating system
Your Compass version or commit
Relevant logs or error messages
Screenshots, with private financial information removed

Please never include real account numbers, transaction details, credentials, encryption keys, database contents, or other sensitive information in an issue.

Suggesting Features

Feature suggestions are welcome.

Please describe:

The problem you are trying to solve
How the feature would help
How you imagine it working
Whether there are simpler alternatives
Any privacy or security implications you have considered

Compass aims to remain understandable, private, and useful. Features that increase complexity, introduce unnecessary online dependencies, or weaken local-first behavior may require additional discussion.

Privacy and Security

Privacy is a core part of Compass.

Contributions should avoid:

Sending financial data to external services without clear user consent
Adding unnecessary telemetry or analytics
Logging sensitive financial information
Storing secrets in source code
Including private data in tests or screenshots
Weakening encryption or local data protections
Adding network dependencies when a local solution is reasonable

Use generated or anonymized data when creating examples, fixtures, screenshots, and tests.

If you believe you have found a serious security vulnerability, please do not publish detailed exploitation instructions in a public issue. Contact the maintainer privately using the repository’s security reporting method, if available.

Financial Features

Compass may analyze financial information, but it should not present itself as a replacement for a qualified financial, tax, accounting, or legal professional.

When contributing financial calculations or educational content:

Explain assumptions clearly
Avoid presenting estimates as guaranteed outcomes
Account for rounding and unusual input values
Add tests for important calculations
Prefer transparent calculations over unexplained recommendations
Clearly distinguish general information from professional advice

Whenever possible, include sources or reasoning for formulas and financial assumptions.

Code Quality

Please try to:

Follow the style already used in the project
Keep code readable
Use descriptive names
Avoid unnecessary abstractions
Add comments where the reasoning is not obvious
Handle errors gracefully
Add or update tests when practical
Avoid unrelated formatting changes in the same pull request

Perfect code is not expected. Thoughtful, understandable code is.

Beginner Contributors

First-time contributors are welcome.

You are encouraged to:

Ask questions
Open draft pull requests
Request feedback before finishing
Work on documentation or testing
Choose issues marked good first issue or help wanted
Share what you tried, even when you are stuck

Nobody is expected to know the entire codebase before contributing.

A draft pull request is often the easiest way to show your progress and receive useful feedback.

AI-Assisted Contributions

Using AI-assisted development tools is allowed, but you are responsible for understanding and reviewing what you submit.

Please verify that AI-assisted changes:

Actually solve the stated problem
Match the existing architecture
Do not introduce security or privacy risks
Do not include fabricated APIs, dependencies, or test results
Do not copy incompatible licensed material
Have been tested by you

Pull requests containing large amounts of generated code without clear review or testing may be asked to undergo additional revision.

Commit Messages

Commit messages should briefly describe the change.

Good examples:

Fix duplicate category totals
Add tests for recurring expenses
Improve Linux setup instructions
Handle empty transaction imports

Commit history does not need to be perfect. Maintainers may squash commits when merging.

Scope and Project Direction

Not every proposed feature will be a good fit for Compass.

A contribution may be declined because it:

Conflicts with the project’s privacy goals
Adds more complexity than long-term value
Duplicates existing functionality
Requires ongoing maintenance the project cannot support
Changes the project in a direction outside its intended scope

This does not mean the idea or contribution was bad. Open-source projects must make deliberate choices about what they can sustainably maintain.

Respectful Collaboration

Be patient, constructive, and respectful.

Disagreement is welcome. Personal attacks, harassment, gatekeeping, and dismissive behavior are not.

Assume good intent, explain your reasoning, and remember that most contributors are volunteering their free time.

Licensing

By submitting a contribution, you agree that your work may be distributed under the same license as the rest of the project.

Please only submit work that you have the right to contribute.

Thank You

Compass is strengthened by every person who tests it, reports a problem, improves an explanation, suggests an idea, or contributes code.

Whether you submit a one-line correction or build an entire feature, thank you for helping make private financial tools more accessible.
