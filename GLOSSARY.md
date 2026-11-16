# Winku

A desktop assistant that lives as a pair of eyes at the edge of the screen. These are the words its docs and code use for things specific to it.

## Surfaces

**Eyes**:
Winku at rest: the small dark shape with two eyes that sits at the edge of the screen and shows what Winku is doing.
_Avoid_: Pill (in user-facing text; it is only the name of the shape), widget, mascot, avatar

**Bar**:
The eyes opened up into a text box for typing a message.
_Avoid_: Input, prompt box, chat box

**Bubble**:
The translucent box under or over the bar where a reply appears.
_Avoid_: Popup, panel, card

**Visual**:
A small page the assistant draws into a reply, such as a chart, a table or a diagram, when showing beats telling.
_Avoid_: Card, panel, render, artifact, sketch

**Wide**:
The bar and bubble at their larger width, for reading back through the thread or showing a visual.
_Avoid_: Expanded, full width, open (the bar is open whenever it shows, at any width)

**Transcript**:
The whole thread shown at once, opened with `Ctrl+J`.
_Avoid_: History (History is where cleared threads and past actions are kept), log

## Conversation

**Thread**:
The one running conversation with the assistant, kept until the user clears it.
_Avoid_: Chat, session (pi's word for the file a thread is stored in)

**Steer**:
A message sent while a reply is running, which the model takes in at its next step instead of after the reply ends.
_Avoid_: Interrupt, queue, follow-up

## Scheduled tasks

**Task**:
A wakeup the assistant scheduled because the user asked it to: a timer, a loop or a watch.
_Avoid_: Job (in user-facing text), cron, reminder (a reminder is one kind of timer)

**Timer**:
A task that runs its prompt once, at a time or after a delay.
_Avoid_: Alarm, one-shot

**Loop**:
A task that runs its prompt again and again, every interval or at delays the model picks (self-paced).
_Avoid_: Recurring job, poll

**Watch**:
A task that runs a command in the background and wakes Winku with each line the command prints.
_Avoid_: Monitor, listener, poll

**Run**:
One scheduled turn: a task's prompt sent to the model, marked `[scheduled: <name>]`.
_Avoid_: Fire, execution, trigger

**Notice**:
A one-line row the scheduler adds to the thread, such as a missed wakeup or a stopped task, which the model also sees.
_Avoid_: Alert, toast (a toast is the bar's temporary message)

## Memory

**Memory**:
Everything Winku keeps about the user between threads: the profile, goals, recap and notes. About me is the user's own file and not part of it.
_Avoid_: Knowledge base, brain, context

**Profile**:
Short, lasting facts about the user that Winku keeps up to date (where they live, what they work on, how they like answers), known in every message.
_Avoid_: About me (that one the user writes), user model, persona

**Goal**:
Something the user is working toward right now ("ship 0.2 by Friday"), known in every message until it is done or dropped.
_Avoid_: Task (a task is a scheduled wakeup), todo, commitment

**Recap**:
A few sentences on what happened in a recent thread, written when Winku tidies its memory and known when the next thread starts.
_Avoid_: Session summary, compaction summary (pi's summary inside one thread)

**Note**:
One dated entry in a topic file: a detail worth keeping that is too specific for the profile. Notes are recalled only when they relate to a message.
_Avoid_: Memory (for a single entry), fact, archive

**Recall**:
Winku finding the notes that relate to a message, by meaning and by keyword, and adding them to that message before the model sees it.
_Avoid_: Retrieval, RAG, lookup

**Tidy**:
A background pass, when the user clears the thread or goes quiet, that reads the conversation and updates the profile, goals and recap, and adds notes.
_Avoid_: Consolidation, compaction (pi's shrinking of a long thread), cleanup
