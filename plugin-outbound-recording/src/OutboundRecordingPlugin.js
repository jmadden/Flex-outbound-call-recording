import React from 'react';
import { VERSION, TaskHelper } from '@twilio/flex-ui';
import { FlexPlugin } from 'flex-plugin';

import { updateConference } from './utils/fetch';
const PLUGIN_NAME = 'OutboundRecordingPlugin';

export default class OutboundRecordingPlugin extends FlexPlugin {
  constructor() {
    super(PLUGIN_NAME);
  }

  /**
   * This code is run when your plugin is being started
   * Use this to modify any UI components or attach to the actions framework
   *
   * @param flex { typeof import('@twilio/flex-ui') }
   * @param manager { import('@twilio/flex-ui').Manager }
   */
  async init(flex, manager) {
    flex.Actions.addListener('beforeStartOutboundCall', async (payload) => {
      console.log(PLUGIN_NAME, 'BEFORE StartOutboundCall payload:', payload);

      let newCallerId =
        manager.store.getState()['outbound-callerid'].NumberSelect.phoneNumber;
      if (newCallerId) {
        payload.callerId = newCallerId;
      } else {
        //No caller id selected yet...
      }
      console.log(PLUGIN_NAME, 'Outbound Caller Id:', payload.callerId);
    });

    const isTaskActive = (task) => {
      const { sid: reservationSid, taskStatus } = task;
      if (taskStatus === 'canceled') {
        return false;
      } else {
        return manager.workerClient.reservations.has(reservationSid);
      }
    };

    const waitForConferenceParticipants = (task) =>
      new Promise((resolve) => {
        const waitTimeMs = 100;
        // For outbound calls, the customer participant doesn't join the conference
        // until the called party answers. Need to allow enough time for that to happen.
        const maxWaitTimeMs = 60000;
        let waitForConferenceInterval = setInterval(async () => {
          const { conference } = task;

          if (!isTaskActive(task)) {
            console.debug(
              PLUGIN_NAME,
              'Call canceled, clearing waitForConferenceInterval'
            );
            waitForConferenceInterval = clearInterval(
              waitForConferenceInterval
            );
            return;
          }
          if (conference === undefined) {
            return;
          }
          const { participants } = conference;
          if (Array.isArray(participants) && participants.length < 2) {
            return;
          }
          const worker = participants.find(
            (p) => p.participantType === 'worker'
          );
          const customer = participants.find(
            (p) => p.participantType === 'customer'
          );

          if (!worker || !customer) {
            return;
          }

          console.debug(
            PLUGIN_NAME,
            'Worker and customer participants joined conference'
          );
          waitForConferenceInterval = clearInterval(waitForConferenceInterval);

          resolve(conference);
        }, waitTimeMs);

        setTimeout(() => {
          if (waitForConferenceInterval) {
            console.debug(
              PLUGIN_NAME,
              `Customer participant didn't show up within ${
                maxWaitTimeMs / 1000
              } seconds`
            );
            clearInterval(waitForConferenceInterval);
            resolve({});
          }
        }, maxWaitTimeMs);
      });

    const handleAcceptedCall = async (task) => {
      const { attributes } = task;

      // We want to wait for all participants (customer and worker)
      console.debug(
        PLUGIN_NAME,
        'Waiting for customer and worker to join the conference'
      );
      const conference = await waitForConferenceParticipants(task);

      const customer = conference.participants.find(
        (p) => p.participantType === 'customer'
      );

      if (!customer) {
        console.warn(PLUGIN_NAME, 'No customer participant.');
        return;
      }
      console.log(PLUGIN_NAME, 'Updating Conference:', conference);
      let confSid = conference.conferenceSid;
      console.log(PLUGIN_NAME, 'Conference Sid:', confSid);
      //Should be same as conf sid from task...
      console.log(PLUGIN_NAME, 'Conference Task Data:', task);
      const conferenceSid = task.attributes.conference.sid;
      const announceUrl =
        'https://handler.twilio.com/twiml/EHf04f98deab4ed4ec514fde9365a92231';
      const conf = await updateConference(confSid, announceUrl);
      console.log(PLUGIN_NAME, 'Updated Conference:', conf);
    };

    const handleReservationAccepted = async (reservation) => {
      const task = TaskHelper.getTaskByTaskSid(reservation.sid);
      if (TaskHelper.isCallTask(task)) {
        await handleAcceptedCall(task);
      }
    };

    manager.workerClient.on('reservationCreated', (reservation) => {
      console.log(PLUGIN_NAME, 'reservationCreated: ', reservation);
      const isOutboundTask =
        reservation.task.attributes.direction === 'outbound';
      if (isOutboundTask) {
        reservation.on('accepted', async (reservation) => {
          await handleReservationAccepted(reservation);
        });
      }
    });
  }
}
