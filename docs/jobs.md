# Long jobs

Back to the [README](../README.md).

A command a turn leaves running in the background ends when the turn ends. Work that takes
longer than a turn is a job: the model, a bot that works or a helper it starts runs
`elu jobs start NAME -- COMMAND` and ends its turn. Every turn with a shell is told so. ELU
runs the job apart from the turn, in the session's folder and in the session's mode, never a
higher one, and writes what it prints to a log beside the session's records. The job goes on
when the turn ends, when you close ELU and when ELU updates. A restart of the computer ends
it, and it is then listed as ended.

- When a job ends, ELU starts the session's working agent again by itself, with one message:
  the job's name, its exit code, how long it ran, where its log is and its last lines. Jobs
  that end within a few seconds of each other come in one message. A turn that works then
  gets it as it gets your messages. No model is called while a job runs.
- A session with jobs is listed under Running in Sessions (`2 jobs running · gate 43m`) and
  is In progress on the Kanban: it waits for your check only once they have ended. Its chat
  shows the same line and its Task lists each job, also on the other computers of its
  project.
- `/stop`, archiving and deleting the session end its jobs, and the chat says so in one line.
  A session in Done or archived gets no turn for a job, and one you stopped gets none from ELU
  until you write to it.
- Below Full access a job runs in ELU's sandbox, with no network, and changes only the files
  its turn may change: a chat's job reads the project folder and changes nothing in it, and
  an editing session's job writes that session's folder, less its protected files. On a
  computer with no sandbox it does not start, and says so.
- When a turn ends while a background command it started still runs, the chat says in one
  line that the command ended with it, and the next turn is told.

## ELU's notes that wait

What ELU tells a session's working agent while it cannot take it (a job ended, the bots
reviewed, a bot answered) starts one turn for all that waits, oldest first. It is never
joined with a message of yours, and none of it goes past your message in the queue.

## Keep going

A session whose Task you approved keeps going until its objectives are met. When they are not
all met, nothing runs and it waits for nothing from you, ELU starts it again after three idle
minutes with one message: "The Task's objectives are not all met and nothing is running.
Carry on, or say exactly what you need from the owner." ELU reads its own records for this
and calls no model. After two such turns in a row with no progress (no objective newly met,
no job started, no change, no question) it stops starting the session, which then waits for
you and says why; your next message starts it again. This is on in Full access and Approve
for me, and off in Ask for approval, in a schedule's runs and in a bot's own chat until you
turn it on with `/keepgoing on`.
