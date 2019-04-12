import { hot } from 'react-hot-loader';
import cloneDeep from 'lodash.clonedeep';
import React, { Component } from 'react';
import { graphql, withApollo } from 'react-apollo';
import dotProp from 'dot-prop-immutable';
import { isEmpty } from 'ramda';
import jsonSchemaDefaults from 'json-schema-defaults';
import { safeDump } from 'js-yaml';
import { withStyles } from '@material-ui/core/styles';
import classNames from 'classnames';
import Spinner from '@mozilla-frontend-infra/components/Spinner';
import HammerIcon from 'mdi-react/HammerIcon';
import { fade } from '@material-ui/core/styles/colorManipulator';
import SpeedDial from '../../../components/SpeedDial';
import SpeedDialAction from '../../../components/SpeedDialAction';
import Dashboard from '../../../components/Dashboard';
import Search from '../../../components/Search';
import DialogAction from '../../../components/DialogAction';
import HelpView from '../../../components/HelpView';
import TaskGroupProgress from '../../../components/TaskGroupProgress';
import TaskGroupTable from '../../../components/TaskGroupTable';
import TaskActionForm from '../../../components/TaskActionForm';
import {
  TASK_GROUP_PAGE_SIZE,
  VALID_TASK,
  ACTIONS_JSON_KNOWN_KINDS,
  INITIAL_CURSOR,
} from '../../../utils/constants';
import db from '../../../utils/db';
import ErrorPanel from '../../../components/ErrorPanel';
import taskGroupQuery from './taskGroup.graphql';
import taskGroupSubscription from './taskGroupSubscription.graphql';
import submitTaskAction from '../submitTaskAction';

const updateTaskGroupIdHistory = id => {
  if (!VALID_TASK.test(id)) {
    return;
  }

  db.taskGroupIdsHistory.put({ taskGroupId: id });
};

@hot(module)
@withApollo
@graphql(taskGroupQuery, {
  options: props => ({
    fetchPolicy: 'network-only',
    errorPolicy: 'all',
    variables: {
      taskGroupId: props.match.params.taskGroupId,
      taskGroupConnection: {
        limit: 20,
      },
      taskActionsFilter: {
        kind: {
          $in: ACTIONS_JSON_KNOWN_KINDS,
        },
        context: {
          $or: [{ $size: 0 }, { $size: 1 }],
        },
      },
    },
  }),
})
@withStyles(theme => ({
  warningPanel: {
    ...theme.mixins.warningPanel,
  },
  dashboard: {
    overflow: 'hidden',
  },
  taskNameFormSearch: {
    marginTop: theme.spacing.triple,
    background: theme.palette.primary.main,
    '&:hover': {
      background: fade(theme.palette.primary.main, 0.9),
    },
    '& $input': {
      transition: 'unset !important',
      width: 'unset !important',
      color: fade(theme.palette.text.primary, 0.5),
      '&:focus': {
        width: 'unset !important',
        color: fade(theme.palette.text.primary, 0.9),
      },
    },
    '& svg': {
      fill: fade(theme.palette.text.primary, 0.5),
    },
  },
}))
export default class TaskGroup extends Component {
  static getDerivedStateFromProps(props, state) {
    const { taskGroupId } = props.match.params;
    const { taskActions, taskGroup } = props.data;
    const groupActions = [];
    const actionInputs = state.actionInputs || {};
    const actionData = state.actionData || {};
    const taskGroupLoaded = taskGroup && !taskGroup.pageInfo.hasNextPage;
    // Make sure data is not from another task group which
    // can happen when a user searches for a different task group
    const isFromSameTaskGroupId =
      taskGroup && taskGroup.edges[0]
        ? taskGroup.edges[0].node.taskGroupId === taskGroupId
        : true;

    if (
      isFromSameTaskGroupId &&
      taskGroupId !== state.previousTaskGroupId &&
      taskActions
    ) {
      updateTaskGroupIdHistory(taskGroupId);
      taskActions.actions
        .filter(action => isEmpty(action.context))
        .forEach(action => {
          const schema = action.schema || {};

          // if an action with this name has already been selected,
          // don't consider this version
          if (!groupActions.some(({ name }) => name === action.name)) {
            groupActions.push(action);
            actionInputs[action.name] = safeDump(
              jsonSchemaDefaults(schema) || {}
            );
            actionData[action.name] = {
              action,
            };
          }
        });

      return {
        groupActions,
        actionInputs,
        actionData,
        previousTaskGroupId: taskGroupId,
        taskGroupLoaded,
      };
    }

    return {
      taskGroupLoaded: isFromSameTaskGroupId ? taskGroupLoaded : false,
    };
  }

  constructor(props) {
    super(props);

    this.previousCursor = INITIAL_CURSOR;
    this.listener = null;
    this.tasks = new Map();
  }

  state = {
    filter: null,
    // eslint-disable-next-line react/no-unused-state
    previousTaskGroupId: '',
    groupActions: [],
    actionLoading: false,
    actionInputs: {},
    actionData: {},
    dialogOpen: false,
    selectedAction: null,
    dialogError: null,
    taskGroupLoaded: false,
    searchTerm: null,
  };

  unsubscribe = () => {
    if (!this.listener) {
      return;
    }

    this.listener.unsubscribe();
    this.listener = null;
  };

  subscribe = ({ taskGroupId, subscribeToMore }) => {
    if (this.listener && this.listener.taskGroupId === taskGroupId) {
      return this.listener;
    }

    if (this.listener && this.listener.taskGroupId !== taskGroupId) {
      this.unsubscribe();
    }

    const unsubscribe = subscribeToMore({
      document: taskGroupSubscription,
      variables: {
        taskGroupId,
        subscriptions: [
          'tasksDefined',
          'tasksPending',
          'tasksRunning',
          'tasksCompleted',
          'tasksFailed',
          'tasksException',
        ],
      },
      updateQuery: (previousResult, { subscriptionData }) => {
        const { tasksSubscriptions } = subscriptionData.data;
        // Make sure data is not from another task group which
        // can happen when a message is in flight and a user searches for
        // a different task group.
        const isFromSameTaskGroupId =
          tasksSubscriptions.taskGroupId === taskGroupId;

        if (
          !previousResult ||
          !previousResult.taskGroup ||
          !isFromSameTaskGroupId
        ) {
          return previousResult;
        }

        let edges;

        if (this.tasks.has(tasksSubscriptions.taskId)) {
          // already have this task, so just update the state
          edges = previousResult.taskGroup.edges.map(edge => {
            if (tasksSubscriptions.taskId !== edge.node.taskId) {
              return edge;
            }

            return dotProp.set(edge, 'node', node =>
              dotProp.set(node, 'status', status =>
                dotProp.set(status, 'state', tasksSubscriptions.state)
              )
            );
          });
        } else {
          // unseen task, so keep the Task and TaskStatus values
          this.tasks.set(tasksSubscriptions.taskId);
          edges = previousResult.taskGroup.edges.concat({
            // eslint-disable-next-line no-underscore-dangle
            __typename: 'TasksEdge',
            node: {
              ...cloneDeep(tasksSubscriptions.task),
              status: {
                state: tasksSubscriptions.state,
                __typename: 'TaskStatus',
              },
            },
          });
        }

        return dotProp.set(previousResult, 'taskGroup', taskGroup =>
          dotProp.set(taskGroup, 'edges', edges)
        );
      },
    });

    this.listener = {
      taskGroupId,
      unsubscribe,
    };
  };

  componentDidUpdate(prevProps) {
    const {
      data: { taskGroup, subscribeToMore },
      match: {
        params: { taskGroupId },
      },
    } = this.props;

    if (prevProps.match.params.taskGroupId !== taskGroupId) {
      this.tasks.clear();
      updateTaskGroupIdHistory(taskGroupId);
      this.subscribe({ taskGroupId, subscribeToMore });
    }

    if (
      taskGroup &&
      this.previousCursor === taskGroup.pageInfo.cursor &&
      taskGroup.pageInfo.hasNextPage
    ) {
      this.fetchMoreTasks();
    }
  }

  handleActionClick = ({ currentTarget: { name } }) => {
    const { action } = this.state.actionData[name];

    this.setState({ dialogOpen: true, selectedAction: action });
  };

  handleActionComplete = taskId => {
    this.handleActionDialogClose();
    this.handleActionTaskComplete(taskId);
  };

  handleActionDialogClose = () => {
    this.setState({
      dialogOpen: false,
      selectedAction: null,
      dialogError: null,
      actionLoading: false,
    });
  };

  handleActionError = e => {
    this.setState({ dialogError: e, actionLoading: false });
  };

  handleActionSubmit = ({ name }) => async () => {
    this.preRunningAction();

    const { taskActions, task } = this.props.data;
    const { actionInputs, actionData } = this.state;
    const form = actionInputs[name];
    const { action } = actionData[name];
    const taskId = await submitTaskAction({
      task,
      taskActions,
      form,
      action,
      apolloClient: this.props.client,
    });

    return taskId;
  };

  handleActionTaskComplete = taskId => {
    this.props.history.push(`/tasks/${taskId}`);
  };

  handleFormChange = (value, name) =>
    this.setState({
      actionInputs: {
        // eslint-disable-next-line react/no-access-state-in-setstate
        ...this.state.actionInputs,
        [name]: value,
      },
    });

  handleStatusClick = async ({ currentTarget: { name } }) => {
    const filter = this.state.filter === name ? null : name;

    this.setState({ filter });
  };

  handleTaskGroupSearchSubmit = taskGroupId => {
    if (this.props.match.params.taskGroupId === taskGroupId) {
      return;
    }

    this.props.history.push(`/tasks/groups/${taskGroupId}`);
  };

  fetchMoreTasks = () => {
    const {
      data,
      match: {
        params: { taskGroupId },
      },
    } = this.props;
    const { fetchMore, taskGroup } = data;

    fetchMore({
      variables: {
        taskGroupId,
        taskGroupConnection: {
          limit: TASK_GROUP_PAGE_SIZE,
          cursor: taskGroup.pageInfo.nextCursor,
          previousCursor: taskGroup.pageInfo.cursor,
        },
        taskActionsFilter: {
          kind: {
            $in: ACTIONS_JSON_KNOWN_KINDS,
          },
          context: {
            $or: [{ $size: 0 }, { $size: 1 }],
          },
        },
      },
      updateQuery: (previousResult, { fetchMoreResult, variables }) => {
        if (
          variables.taskGroupConnection.previousCursor === this.previousCursor
        ) {
          const { edges, pageInfo } = fetchMoreResult.taskGroup;

          this.previousCursor = variables.taskGroupConnection.cursor;

          if (!edges.length) {
            return previousResult;
          }

          const filteredEdges = edges.filter(edge => {
            if (this.tasks.has(edge.node.taskId)) {
              return false;
            }

            this.tasks.set(edge.node.taskId);

            return true;
          });

          return dotProp.set(previousResult, 'taskGroup', taskGroup =>
            dotProp.set(
              dotProp.set(
                taskGroup,
                'edges',
                previousResult.taskGroup.edges.concat(filteredEdges)
              ),
              'pageInfo',
              pageInfo
            )
          );
        }
      },
    });
  };

  preRunningAction = () => {
    this.setState({ dialogError: null, actionLoading: true });
  };

  handleSearchTaskSubmit = searchTerm => {
    this.setState({ searchTerm });
  };

  render() {
    const {
      groupActions,
      filter,
      actionLoading,
      dialogOpen,
      selectedAction,
      actionInputs,
      dialogError,
      taskGroupLoaded,
      searchTerm,
    } = this.state;
    const {
      description,
      match: {
        params: { taskGroupId },
      },
      data: { taskGroup, error, loading, subscribeToMore },
      classes,
    } = this.props;
    // Make sure data is not from another task group which
    // can happen when a user searches for a different task group
    const isFromSameTaskGroupId =
      taskGroup && taskGroup.edges[0]
        ? taskGroup.edges[0].node.taskGroupId === taskGroupId
        : true;

    this.subscribe({ taskGroupId, subscribeToMore });

    if (!this.tasks.size && taskGroup && isFromSameTaskGroupId) {
      taskGroup.edges.forEach(edge => this.tasks.set(edge.node.taskId));
    }

    return (
      <Dashboard
        title="Task Group"
        className={classes.dashboard}
        helpView={<HelpView description={description} />}
        search={
          <Search
            onSubmit={this.handleTaskGroupSearchSubmit}
            defaultValue={taskGroupId}
          />
        }>
        <ErrorPanel
          error={error}
          warning={Boolean(taskGroup)}
          className={classNames({
            [classes.warningPanel]: Boolean(taskGroup),
          })}
        />
        {taskGroup && (
          <TaskGroupProgress
            taskGroupId={taskGroupId}
            taskGroupLoaded={taskGroupLoaded}
            taskGroup={taskGroup}
            filter={filter}
            onStatusClick={this.handleStatusClick}
          />
        )}
        {!loading && (
          <Search
            formProps={{ className: classes.taskNameFormSearch }}
            placeholder="Name contains"
            onSubmit={this.handleSearchTaskSubmit}
          />
        )}
        <br />
        {!error && loading && <Spinner loading />}
        {!loading && (
          <TaskGroupTable
            searchTerm={searchTerm}
            filter={filter}
            taskGroupConnection={taskGroup}
          />
        )}
        {!loading && groupActions && groupActions.length ? (
          <SpeedDial>
            {groupActions.map(action => (
              <SpeedDialAction
                requiresAuth
                tooltipOpen
                key={action.title}
                ButtonProps={{
                  name: action.name,
                  disabled: actionLoading,
                }}
                icon={<HammerIcon />}
                tooltipTitle={action.title}
                onClick={this.handleActionClick}
              />
            ))}
          </SpeedDial>
        ) : null}
        {dialogOpen && (
          <DialogAction
            fullScreen={Boolean(selectedAction.schema)}
            open={dialogOpen}
            error={dialogError}
            onSubmit={this.handleActionSubmit(selectedAction)}
            onComplete={this.handleActionComplete}
            onError={this.handleActionError}
            onClose={this.handleActionDialogClose}
            title={selectedAction.title}
            body={
              <TaskActionForm
                action={selectedAction}
                form={actionInputs[selectedAction.name]}
                onFormChange={this.handleFormChange}
              />
            }
            confirmText={selectedAction.title}
          />
        )}
      </Dashboard>
    );
  }
}
