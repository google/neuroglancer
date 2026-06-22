.. _governance:

Neuroglancer Community Governance
==================================

1. Overview
-----------

Neuroglancer is maintained by a distributed, community-led governance
structure designed to reduce review bottlenecks, empower frequent
contributors, and ensure the project's long-term sustainability.

2. Background
-------------

Neuroglancer has become a foundational tool for the connectomics and
high-dimensional imaging communities. The project has grown to a scale where
distributed ownership is essential to sustain the pace of contribution and
reduce institutional risk for organizations that depend on it.

3. Governance Structure
------------------------

Neuroglancer uses a tiered "Ladder of Participation" to distribute authority
based on demonstrated merit and commitment.

A. The Contributor Ladder
~~~~~~~~~~~~~~~~~~~~~~~~~

**Contributors**
  Anyone submitting code, documentation, or bug reports. Open to anyone
  interested in the project.

**Community Managers**
  Contributors who provide value by responding to issues, closing stale issues
  and pull requests, labelling issues and pull requests, or maintaining the
  wiki. Community Managers may or may not contribute code directly.

**Reviewers**
  Trusted contributors with a history of quality PRs. They are granted
  "Review" permissions to vet code for style and logic.

**Maintainers**
  Proven reviewers granted Commit Access. They have the authority to merge PRs
  that have been approved by the community.

**Technical Lead (Jeremy Maitin-Shepard)**
  As the original architect and deepest expert on Neuroglancer's design,
  Jeremy serves as the project's Technical Lead. He retains final authority
  on core architectural decisions — not as a gatekeeper, but as the person
  best positioned to protect the long-term coherence and integrity of the
  codebase. In practice, the community's distributed review process handles
  the vast majority of decisions. Jeremy's role is to provide guidance on the
  hardest architectural questions, serve as a tie-breaker for the Steering
  Committee when consensus cannot be reached, and ensure that the project's
  technical vision remains consistent as the contributor base grows.

B. The Steering Committee
~~~~~~~~~~~~~~~~~~~~~~~~~

A small group responsible for the project roadmap and high-level decisions.

**Composition**
  Members are leads from the most active contributing organizations and labs,
  including the Technical Lead.

**Current Members**
  Jeremy Maitin-Shepard, Forrest Collman, Matteo Cantarelli, Stuart Berg

**Meetings**
  Quarterly public meetings open to anyone in the community to observe and
  participate in discussion. Voting is limited to committee members.

**Membership Principle**
  Membership is distributed across stakeholders who have demonstrated a
  commitment of developer resources to Neuroglancer. This is explicitly
  designed to incentivize sustained investment. Gathering feedback from the
  broader user community is a priority, but holding a decisive vote is gated
  on making direct contributions.

**Responsibilities**

- Vote on promoting individuals to Community Manager, Reviewer, Maintainer,
  and Steering Committee status, as well as defining Maintainers as owners of
  subsystems. The committee uses activity on GitHub issues and pull requests to
  identify candidates for promotion.
- Maintain a long-term roadmap for major architectural changes and a priority
  list of desired features.
- Discuss how the governance structure is affecting the technical and social
  dynamics of the project, and make adjustments to address both specific and
  structural issues.

  *Example:* If a merged PR breaks an important function, the committee
  analyzes whether the root cause was social (insufficient review), technical
  (missing tests, poor architectural design, code rot), and makes
  recommendations to prevent similar problems.

**Agenda**
  The agenda is maintained in a publicly viewable location, editable by
  Community Managers, Reviewers, Maintainers, and Steering Committee members.
  It follows a template structured around the responsibilities above.

C. RFC Process
~~~~~~~~~~~~~~

Significant changes that warrant asynchronous discussion are proposed through
an RFC process. The goal is not to require broad commentary on every change,
but to provide a transparent mechanism for discussing weighty topics outside of
meetings.

RFCs are submitted as documents checked into the documentation section of the
repository, using the standard PR review process to manage discussion.

4. Workflows
------------

**The "Two-Approvals" Policy**
  Standard PRs can be merged by any Maintainer once they have received at least
  two approvals from Reviewers or Maintainers. 
  Presently the number of reviewers is small (n=3, and so a PR written by a Maintainer may be merged with one approval from another Maintainer.
  The tech-lead may merge PRs that are considered "hot-fixes" or cosmetic changes with no approvals.
  Over time, as the number of Reviewers grows, the policy will be updated.
  
**PR Review Escalation**
  If a PR has not received feedback from a Reviewer or Maintainer for more than
  a week, an escalation process notifies the community of Reviewers and
  Maintainers to provide feedback.

**Stale PR Closing**
  If a PR has received feedback but the contributor has not responded for over a
  month, that pull request will be closed. The contributor may re-open it when
  ready to engage, or another community member may pick up the work.

**Subsystem Ownership**
  Lead Maintainers are designated for specific subsystems (e.g., zarr or
  graphene datasources, screenshot feature). Owners may fast-track changes
  within their domain using a "Lazy Consensus" model: non-breaking changes
  that receive no objection within 3 days may be merged without additional
  review. Issues arising from such merges are reviewed at Steering Committee
  meetings.
